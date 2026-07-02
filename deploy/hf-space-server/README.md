---
title: Genesis Infinity API Server
emoji: 🌐
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Genesis Infinity — live API server

Runs Genesis Infinity's HTTP API (`src/server/`) persistently, backing the
static frontend hosted on GitHub Pages. The server boots with **no model
loaded** — backend/model choice is made live from the frontend's "Model
settings" dialog (a local GGUF searched/downloaded from Hugging Face Hub,
or an API model id), not fixed by this Space's configuration.

Configure via this Space's **Settings → Repository secrets**:

| Secret | Meaning |
|---|---|
| `SERVER_API_KEY` | A shared secret the frontend must send back. **Required for any real deployment** — without it, anyone with this Space's URL can drive turns on your account's quota, or trigger model downloads. |
| `CORS_ORIGIN` | The GitHub Pages origin allowed to call this API (e.g. `https://<user>.github.io`) |
| `API_BASE_URL` | Optional. e.g. `https://router.huggingface.co/v1` — only needed to make the frontend's "API" model option available. |
| `API_KEY` | Optional, required together with `API_BASE_URL`. Your Hugging Face access token (or other provider's key) — stays server-side only; the frontend only ever sends a model id, never this key. |

Optional: `EXPERIENCE_DIR` (defaults to `examples/goku-vs-venom`), `CHARACTER_ID`
(defaults to `goku`), `MODELS_DIR` (defaults to `models` — where a
frontend-picked local GGUF is cached; only one is kept on disk at a time).

**Known limitation:** free-tier HF CPU Spaces can sleep after a period of
inactivity, which works against "always-on" serving. If this becomes a
problem in practice, a paid always-on tier (or another host entirely) may
be worth revisiting.

This Space's contents are synced automatically from the
`claude/claude-md-docs-i19au3` branch of the Genesis Infinity GitHub repo
by `.github/workflows/sync-hf-space-server.yml` — do not edit files here
directly, they'll be overwritten on the next push.
