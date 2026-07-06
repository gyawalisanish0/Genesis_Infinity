# Frontend Architecture Document: Genesis Infinity

> See `docs/BACKEND_ARCHITECTURE.md` for the RPG engine and the `server/`
> HTTP API this UI is a client of — endpoint shapes, the `BackendStatus`
> state machine, and the server-side-only credential design are documented
> there, not repeated here.

## Overview

`frontend/` (`index.html`, `style.css`, `app.js`) is a small static
single-page UI, plain HTML/CSS/JS with no build step and no framework
dependency, styled dark and chat-like in the spirit of Open WebUI without
depending on that project's codebase (a fork was considered and rejected:
a large Python+Svelte codebase for a project that's otherwise 100%
TypeScript, built around generic chat rather than game-specific UI, with
an ongoing upstream-merge tax). It's deployed as-is to GitHub Pages (see
`.github/workflows/deploy-pages.yml`) and talks to a separately-hosted
`server/` instance over HTTP.

## Connection settings

API base URL, shared secret (`X-Api-Key`), and character id are entered
once via a `<dialog>` and cached in `localStorage` (`genesis-infinity-connection`)
so a returning visitor reconnects automatically. `apiFetch()` is the one
place that attaches the `X-Api-Key` header and unwraps `{error}` JSON
bodies into thrown `Error`s.

## Connect → ready flow

On connect, the UI calls `GET /api/health` (to confirm the server is
reachable and show the Experience name) and starts polling
`GET /api/backend/status` every 3s. The composer stays disabled until
status is `"ready"`; the moment it flips to ready, the UI fetches
`GET /api/scope` once and renders the stats sidebar. This decouples
"connected to a server" from "a model is loaded and playable" — the two
were the same moment before runtime model-picking existed, but aren't
anymore.

## Stats sidebar

Renders `Scope` (the same shape the AI model itself sees) as: HP as a
severity-colored meter (green above 50%, amber above 25%, red below),
armor class as a plain stat tile, current location, inventory, and who
else is present. Collapses below the chat log on narrow (phone) viewports
rather than beside it. Re-rendered from the `scope` bundled in every
`POST /api/turn` response, so it never needs a second round trip per turn.

## Chat

Submitting the composer appends the player's line, then a "pending"
narrator bubble (three animated dots — feedback that the Engine is working,
shown the instant a turn starts rather than leaving a dead gap until it
finishes), then streams `POST /api/turn` via `postSSE()`. Can't use the
browser's native `EventSource` here — it's GET-only with no request body or
custom headers, and this needs POST plus `X-Api-Key` — so `postSSE` reads
the `fetch` response's body stream directly and splits it into SSE frames
by hand (`event: ...\ndata: ...\n\n`).

Three event types drive the UI (see `docs/BACKEND_ARCHITECTURE.md`'s
"Reasoning models & live tool activity" for the server side):

- **`tool_call`** — appended live to a `<details class="tool-log">` (one
  per turn, revealed on the first call rather than always visible), each
  entry a compact `name(params)` line, the summary updating to
  `Tool calls (N)` — a small Codex/Claude-Code-style feed of what the
  Engine is actually doing mid-turn, not just the end result.
- **`done`** — carries `{narration, reasoning, scope}`. The tool log (if it
  ever appeared) collapses rather than disappears, so the activity stays
  inspectable after the fact; if `reasoning` is present (a reasoning model's
  extracted chain-of-thought — see the backend doc), a collapsed-by-default
  `<details class="reasoning-block">` labeled "Thinking" is inserted right
  before the narration bubble; the pending bubble then loses its dots and
  becomes the real narration text; `scope` re-renders the sidebar exactly
  as before.
- **`error`** — the pending bubble and any (empty) tool log are removed,
  and the error is shown as a `system` message, same as a failed
  non-streaming request used to look.

## Turn gating & the persistent event stream

Once a model becomes ready, `connectEventStream()` opens a **second**,
long-lived connection (`GET /api/events`, via the same hand-rolled SSE
reader `postSSE` uses, factored out into `readSSE`) and keeps it open for
the rest of the session — see `docs/BACKEND_ARCHITECTURE.md`'s Dynamic
Timeline-Driven Turn Engine, Phase 2, for why: an NPC's autonomous turn can
happen *between* player messages, with no in-flight request of the
frontend's own to carry it.

The composer is gated on two flags, `modelReady` (from the usual status
poll) and `hasTurn` (whether it's currently the player's own scheduled
turn) — both must be true for `#input`/`#send-btn` to be enabled
(`updateComposerEnabled()`). `hasTurn` starts `false` and only flips to
`true` on a `your_turn` event from the persistent stream; submitting a
turn immediately flips it back to `false` (a submission consumes the
player's turn — the composer does **not** re-enable when that request
finishes, only on the *next* `your_turn`), except on a failed submission,
which restores `hasTurn` so the player can retry a turn that never
actually resolved.

Two more event types arrive only on this stream, both scoped to an
autonomous NPC turn rather than one the player submitted:

- **`turn_start`** — creates the same tool-log + pending-bubble UI
  scaffold the composer's own submit handler creates locally, since
  nothing local triggered this turn.
- **`turn_done`** — carries `{characterId, narration, reasoning, scope}`;
  finalized exactly like the per-turn stream's own `done` (collapse the
  tool log, insert a reasoning block if present, replace the pending
  bubble's dots with the real text, re-render the sidebar from `scope`).

## Experiences dialog

The topbar's Experience name doubles as a button opening the Experiences
`<dialog>` — the runtime package picker (see
`docs/BACKEND_ARCHITECTURE.md`'s Experience Packages). It has two parts:

- **Installed list** (`#experience-list`) — `GET /api/experiences`,
  rendered with the same imperative list pattern as the model dialog's
  saved profiles: the current package highlighted, name + optional
  version/description per row, click-to-switch on any other row. A
  switch (`POST /api/experiences/select`) closes the dialog, clears the
  chat log (a different Experience is a different world — the old
  transcript describes nothing real anymore), updates the topbar name,
  and resets `hasTurn` — the composer re-enables on the rebuilt
  scheduler's next `your_turn` (or stays gated on a model being loaded
  at all, if the server was idle). The sidebar refreshes automatically
  through the existing status-poll ready-transition, since a switch with
  a loaded model cycles status ready → starting → ready.
- **Zip import** — the frontend's first file input. The picked File is
  POSTed as the raw `application/zip` body via the same `apiFetch`
  (no multipart, no new upload machinery), and the list refreshes on
  success. Errors surface in the dialog's own status line, same
  convention as the model dialog.

A package row whose `customCharacter` is present (see
`docs/BACKEND_ARCHITECTURE.md`'s Experience Packages) also gets a small
"+" button (`.profile-add`) opening the **create-character dialog**
(`#create-character-dialog`) — a name field plus one number input per
ability/skill the Experience's ruleset declares (`buildAllocationList`),
each defaulting to that pool's `floor`. A running "N / pool points
spent" readout per pool (`pointBuySpent`) turns red (`.over-budget`) and
disables Submit the moment an allocation exceeds `abilityPointBuy.pool`
or `skillPointBuy.pool` — purely a responsive UI; the server
re-validates every allocation authoritatively regardless (see
`resolvePointBuyAllocation`), so the client-side check is advisory, not
a substitute. Submitting posts to
`POST /api/experiences/:id/characters`, then runs the exact same
post-switch UI update as selecting an existing package
(`onExperienceSwitched` — chat log cleared, topbar name updated,
`hasTurn` reset), shared between both flows since creating a character
also always makes it the active Experience/player.

## Model settings dialog

A separate "Model settings" `<dialog>`, opened from a topbar status
button that shows the live model name/status (polled from
`GET /api/backend/status`), is the runtime backend/model picker. It has
three parts: an unload action, saved model profiles, and tabs for
finding a new model. It also **auto-opens once per connection** if status
comes back `"idle"` — a fresh connection has no usable chat yet, so the
picker is forced in front of it rather than leaving an apparently-live
composer sitting over a disabled/broken-looking chat. Tracked by a
one-shot `autoOpenedModelDialog` flag reset at the top of `connect()`, so
it won't keep popping back if the user closes it while still idle.

**Unload.** A button (`#model-unload-btn`, enabled only while a model is
`"ready"`) posts to `POST /api/backend/unload`, freeing the server's
loaded model without picking a replacement.

**Saved model profiles.** Every model that successfully reaches `"ready"`
(local GGUF or API) is auto-saved to `localStorage`
(`genesis-infinity-model-profiles`) — a profile is `{type, displayName,
repoId+filename | provider+model, lastUsed}`, keyed so reloading the same
model updates its `lastUsed` rather than duplicating the entry. Saved per
browser/device, same as connection settings — there's no server-side
profile storage. The list (`#model-profiles-list`) shows each profile
with a type badge ("Local"/"API"), highlights whichever one matches the
server's current `"ready"` backend, and offers a `×` to remove it
(`removeProfile`) or a click anywhere else on the row to reload it
(routed through the same `loadLocalModel`/`useApiModel` functions the
search/API tabs use, so a saved profile and a freshly-found model go
through identical code). A `llamaCpp` profile is only recorded once
`GET /api/backend/status` actually reports `"ready"` with a matching
`modelPath` — an attempt that errors out never gets saved.

**Finding a new model:**

- **Local GGUF tab** — searches `GET /api/models/search` (Hugging Face
  Hub's live GGUF-tagged catalogue), lists a chosen repo's files via
  `GET /api/models/:repoId/files`, and posts
  `{type: "llamaCpp", repoId, filename}` to `POST /api/backend` on file
  click. The server owns the actual download/disk-cap policy; the
  frontend only ever displays progress via status polling.
- **API tab** — fetches `GET /api/backend/providers` (on tab switch) to
  populate a provider `<select>` with only the providers this server
  actually has a key for; shows "no API providers configured" and
  disables the form if that list is empty. Once a provider is picked (on
  tab switch and on the provider `<select>`'s `change` event), fetches
  `GET /api/models/api/:provider` and, if that provider has a public free-model
  catalogue (only OpenRouter does today — see `apiModelCatalogue.ts` in
  `docs/BACKEND_ARCHITECTURE.md`), shows a second `<select>` of free,
  tool-calling-capable models instead of a blind text field — nobody
  reasonably types an exact model slug from memory on a phone. A manual
  "or enter a model id" text field stays available underneath (required
  only when the provider has no catalogue) and, if filled in, overrides
  the dropdown — so advanced users can still target a model that isn't
  free or isn't in the list. Posts `{type: "api", provider, model}` for
  the chosen provider id and whichever model id won. The frontend never
  collects or transmits an actual API credential (base URL / key) for any
  provider — only ever a provider id and a model id string — since those
  credentials are server-side-only secrets, one per provider (see
  `docs/BACKEND_ARCHITECTURE.md`).

Both the local-file click and the API-form submit (and reloading a saved
profile) go through a `modelSwitchInFlight` guard so a double-tap can't
fire two overlapping `POST /api/backend` calls — the matching server-side
`409` guard is the authoritative fix (see `docs/BACKEND_ARCHITECTURE.md`),
this is the client-side half that stops the double-tap from happening at
all. Errors from any of these are surfaced directly in the dialog's
status line (`#model-dialog-status`) rather than the main chat log, since
the user is already looking at the dialog when they happen.
