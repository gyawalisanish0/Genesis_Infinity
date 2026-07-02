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
| `HF_API_KEY` | Optional. A Hugging Face access token — enables "Hugging Face" as an API provider option in the frontend's model picker. |
| `OPENROUTER_API_KEY` | Optional. An OpenRouter API key — enables "OpenRouter" as an API provider option. |

Each API provider is enabled independently by setting its key — set one, both,
or neither (local GGUF models via the frontend's picker work either way). The
frontend only ever sends a provider id + model id string; the actual key never
leaves the server. See `src/server/apiProviders.ts` for the full provider
registry — adding a new provider there (base URL + a new key env var) makes it
available to every deployment without any frontend changes.

Optional: `EXPERIENCE_DIR` (defaults to `examples/goku-vs-venom`), `CHARACTER_ID`
(defaults to `goku`), `MODELS_DIR` (defaults to `models` — where a
frontend-picked local GGUF is cached; only one is kept on disk at a time),
`DEBUG` (`true`/`1` to log each turn's input, tool calls, and final narration
to this Space's container logs — the server equivalent of the CLI's `--debug`
flag, useful for diagnosing what an API-backed model actually did on a turn).

**Known limitation:** free-tier HF CPU Spaces can sleep after a period of
inactivity, which works against "always-on" serving. If this becomes a
problem in practice, a paid always-on tier (or another host entirely) may
be worth revisiting.

This Space's contents are synced automatically from the `main` branch of
the Genesis Infinity GitHub repo by `.github/workflows/sync-hf-space-server.yml`
— do not edit files here directly, they'll be overwritten on the next push.
