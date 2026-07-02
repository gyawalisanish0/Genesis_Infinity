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

Submitting the composer posts `{input}` to `POST /api/turn` and appends
both the player's line and the returned narration to the message log.

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
