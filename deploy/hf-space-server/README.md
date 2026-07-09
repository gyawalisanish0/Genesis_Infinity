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
| `DEFAULT_API_PROVIDER` / `DEFAULT_API_MODEL` | Optional. Preset a model to **auto-load at boot** so a first-time visitor can play immediately with no setup — e.g. `openrouter` + `qwen/qwen-2.5-72b-instruct`. Requires the matching provider key above. Pick a model that reliably does native tool-calling (an *instruct* model, not a "reasoning"/R1 one). **⚠️ Cost/abuse:** with a preset paid model, a public frontend, and no `SERVER_API_KEY`, anyone with the URL drives turns on your key — use a free model, set an OpenRouter spend cap, or keep `SERVER_API_KEY` set. |

Each API provider is enabled independently by setting its key — set one, both,
or neither (local GGUF models via the frontend's picker work either way). The
frontend only ever sends a provider id + model id string; the actual key never
leaves the server. See `src/server/apiProviders.ts` for the full provider
registry — adding a new provider there (base URL + a new key env var) makes it
available to every deployment without any frontend changes.

Optional: `EXPERIENCE_DIR` (the bootstrap Experience, defaults to
`examples/blackline-action`; its parent directory is always scanned as an
Experience-package discovery root too, so every package under `examples/`
appears in the picker — see below), `CHARACTER_ID`
(defaults to `kestrel` — only used as a fallback if the selected Experience
doesn't declare its own `playerCharacterId` and this id isn't found on
its sheet), `MODELS_DIR` (defaults to `models` — where a frontend-picked
local GGUF is cached; only one is kept on disk at a time), `DEBUG`
(`true`/`1` to log each turn's input, tool calls, and final narration to
this Space's container logs — the server equivalent of the CLI's
`--debug` flag, useful for diagnosing what an API-backed model actually
did on a turn).

A crashed turn (the model calling a tool in a way the schema allows but
the engine didn't expect — e.g. a free-tier model skipping an optional
parameter) is always logged to this Space's container logs with an
`[error]` prefix, regardless of `DEBUG` — this is the one place a crash
during an autonomous NPC turn is guaranteed to surface, since there may
be no connected client at that moment for the frontend's own error
bubble to reach.

**Experience packages:** the frontend's Experiences dialog (opened from
the topbar Experience name) lists every installed package, switches
between them at runtime, and imports new ones from a `.zip` upload — see
`docs/BACKEND_ARCHITECTURE.md`'s Experience Packages section. Imported
packages are installed under `EXPERIENCES_DIR` (defaults to
`experiences/`) — on this Space, that directory lives on the container's
ephemeral filesystem, so **imports don't survive a Space restart/rebuild**
unless persistent storage is configured for it. The bootstrap
`EXPERIENCE_DIR` itself is unaffected by restarts either way, since it's
part of the repo this Space syncs from.

**Known limitation:** free-tier HF CPU Spaces can sleep after a period of
inactivity, which works against "always-on" serving. If this becomes a
problem in practice, a paid always-on tier (or another host entirely) may
be worth revisiting.

This Space's contents are synced automatically from the `main` branch of
the Genesis Infinity GitHub repo by `.github/workflows/sync-hf-space-server.yml`
— do not edit files here directly, they'll be overwritten on the next push.
