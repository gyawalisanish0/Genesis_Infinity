# `deploy/` — hosting recipes

Container recipes for running Genesis Infinity on [Hugging Face
Spaces](https://huggingface.co/spaces). Each subdirectory is a self-contained
Space (Docker SDK) synced from this repo's `main` branch; each has its own
README with the specifics.

| Directory | What it is |
|---|---|
| [`hf-space-server/`](hf-space-server/) | The **live API server** (`src/server/`) that backs the web frontend. Boots with no model loaded — backend/model is chosen at runtime from the frontend. Configured via Space repository secrets. |
| [`hf-space/`](hf-space/) | A **real-model CPU smoke test** — runs `npm run play` against a small local model through the example Experience, scripting a few turns. Output goes to the Space's container logs; there's no interactive UI. |

The static web client itself (`frontend/`) is hosted separately (e.g. GitHub
Pages) and simply points at a running server — see
[`frontend/README.md`](../frontend/README.md).
