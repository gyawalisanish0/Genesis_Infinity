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
`GET /api/backend/status`), is the runtime backend/model picker:

- **Local GGUF tab** — searches `GET /api/models/search` (Hugging Face
  Hub's live GGUF-tagged catalogue), lists a chosen repo's files via
  `GET /api/models/:repoId/files`, and posts
  `{type: "llamaCpp", repoId, filename}` to `POST /api/backend` on file
  click. The server owns the actual download/disk-cap policy; the
  frontend only ever displays progress via status polling.
- **API tab** — posts `{type: "api", model}` for a typed model id. The
  frontend never collects or transmits an actual API credential (base
  URL / key) — only ever a model id string — since that credential is a
  server-side-only secret (see `docs/BACKEND_ARCHITECTURE.md`).

Errors from either tab are surfaced directly in the dialog's status line
(`#model-dialog-status`) rather than the main chat log, since the user is
already looking at the dialog when they happen.
