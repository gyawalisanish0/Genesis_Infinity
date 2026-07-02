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
static frontend hosted on GitHub Pages. Uses the `api` `LlmDriver` backend
(Hugging Face Inference Providers by default) rather than a local model, so
this Space stays lightweight — no multi-GB GGUF download, unlike
`genesis-infinity-cpu-test`.

Configure via this Space's **Settings → Repository secrets**:

| Secret | Meaning |
|---|---|
| `API_BASE_URL` | e.g. `https://router.huggingface.co/v1` |
| `API_KEY` | Your Hugging Face access token (or other provider's key) |
| `API_MODEL` | The model id to use |
| `SERVER_API_KEY` | A shared secret the frontend must send back. **Required for any real deployment** — without it, anyone with this Space's URL can drive turns on your account's quota. |
| `CORS_ORIGIN` | The GitHub Pages origin allowed to call this API (e.g. `https://<user>.github.io`) |

Optional: `EXPERIENCE_DIR` (defaults to `examples/goku-vs-venom`), `CHARACTER_ID`
(defaults to `goku`).

**Known limitation:** free-tier HF CPU Spaces can sleep after a period of
inactivity, which works against "always-on" serving. If this becomes a
problem in practice, a paid always-on tier (or another host entirely) may
be worth revisiting.

This Space's contents are synced automatically from the
`claude/claude-md-docs-i19au3` branch of the Genesis Infinity GitHub repo
by `.github/workflows/sync-hf-space-server.yml` — do not edit files here
directly, they'll be overwritten on the next push.
