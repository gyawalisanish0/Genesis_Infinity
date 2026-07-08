# `frontend/` — the web client

A single-page web client for playing Genesis Infinity in the browser. Plain
HTML, CSS, and JavaScript — no framework, no build step, three files:

| File | Role |
|---|---|
| `index.html` | Markup and the dialog scaffolding (settings, model picker, Experiences, character panel). |
| `style.css` | The full theme, including the brand identity (see [docs/BRAND.md](../docs/BRAND.md)). |
| `app.js` | All behavior — connection, status polling, turn submission, SSE event handling, rendering. |

## How it connects

The frontend is **static** and hosts nothing itself. It talks to a separately
running Genesis Infinity **server** (see [`src/server/`](../src/) and
[`deploy/`](../deploy/)) over HTTP: you point it at a server's base URL (and
optional API key) in the connection settings, and from there it polls backend
status, streams turns over Server-Sent Events, and renders the character
scope.

Because "connected to a server" and "a model is loaded and playable" are
separate states, the UI guides you through picking a backend/model at runtime
before the composer enables.

## Running it locally

Any static file server works — it just needs to reach a running server. For
example:

```bash
npx serve frontend
# then open the printed URL and set the server base URL in settings
```

Start a server to point it at with `npm run serve` from the repo root.

For the full design — status polling, the turn/event streams, the character
panel, the Experiences and model dialogs — see
**[docs/FRONTEND_ARCHITECTURE.md](../docs/FRONTEND_ARCHITECTURE.md)**.
