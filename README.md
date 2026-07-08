<div align="center">

# GENESIS ∞ INFINITY

### Author the world. The engine plays it.

**Genesis Infinity** is an engine for AI-driven RPGs. You author the world,
its characters, and its rules; the engine runs the turns, adjudicates every
action against those rules, and keeps the story consistent — turn after turn,
across a whole cast of characters.

</div>

---

## What you can build

A **world** of connected places, a **cast** of characters with their own
stats, techniques, and voices, and a **ruleset** that binds them — packaged
as a single, portable **Experience** you (or your players) can drop in and
play. The engine handles the hard part: interpreting what a player *tries* to
do, deciding whether the rules allow it, resolving the outcome, and narrating
it in character.

You don't write engine code to make a world. You write three JSON files. See
**[Authoring Experiences](docs/EXPERIENCE_SCHEMA.md)** for the complete
contract, or the [`examples/`](examples/) folder for a working package.

## What the engine does

- **AI turn loop.** Each turn, the model reads the current scene, calls tools
  to act, and narrates the result — all inside one adjudicated loop.
- **Rules adjudication.** A separate model-routed validator judges whether an
  attempted action is valid, neutral, or invalid before it takes effect —
  players can't narrate their way past the rules.
- **Dice & skill checks.** D&D-5e-inspired difficulty tiers and DCs for
  contested and non-combat checks, resolved mechanically, not by vibes.
- **Effects, items & hazards.** Authored effects (buffs/debuffs), a carriable
  item catalog, and environmental conditions that bite when you enter a node.
- **A living world.** Autonomous NPC turns, a wall-clock-anchored timeline,
  and a derived-from-events state model (positions, HP, and inventory are
  computed from an event log, never hand-edited).
- **Portable Experiences.** Discover, hot-switch, and import packages (as
  `.zip`) at runtime; let players build their own character via point-buy.
- **Pluggable model backends.** Run a local GGUF model via
  [node-llama-cpp](https://github.com/withcatai/node-llama-cpp), or any
  OpenAI-compatible API (Hugging Face Inference Providers, OpenRouter, …) —
  same engine, config-only difference.

## Quickstart

Requires **Node.js 22+**.

```bash
git clone https://github.com/gyawalisanish0/Genesis_Infinity.git
cd Genesis_Infinity
npm install
```

**Play in the terminal** against a local GGUF model:

```bash
npm run play -- \
  --experience examples/goku-vs-venom \
  --model /path/to/model.gguf \
  --character goku
```

Or against an OpenAI-compatible API (the key is read from an env var, never
passed on the command line):

```bash
export HF_TOKEN=...   # your provider key
npm run play -- \
  --experience examples/goku-vs-venom \
  --backend api \
  --api-base-url https://router.huggingface.co/v1 \
  --api-model meta-llama/Llama-3.1-8B-Instruct \
  --api-key-env HF_TOKEN \
  --character goku
```

**Run the HTTP server** (the backend for the web frontend; picks its model at
runtime, so no model flags here):

```bash
npm run serve
```

**Type-check** the whole project (there's no build step — `tsx` runs the
TypeScript directly):

```bash
npm run typecheck
```

## Repository layout

| Path | What's there |
|---|---|
| [`src/`](src/) | The engine — turn loop, rules, state, tools, server, and more. |
| [`frontend/`](frontend/) | The static web client (plain HTML/CSS/JS SPA). |
| [`examples/`](examples/) | Ready-to-play Experience packages. |
| [`docs/`](docs/) | Architecture and authoring documentation. |
| [`deploy/`](deploy/) | Container recipes for hosting the server / frontend. |

## Documentation

- **[Authoring Experiences](docs/EXPERIENCE_SCHEMA.md)** — the package schema
  contract, for world creators.
- **[Backend architecture](docs/BACKEND_ARCHITECTURE.md)** — how the engine,
  server, and data model fit together.
- **[Frontend architecture](docs/FRONTEND_ARCHITECTURE.md)** — the web
  client's design.
- **[Brand](docs/BRAND.md)** — identity, voice, and visual language.

## License

The **engine — all source code and documentation** in this repository — is
licensed under the [MIT License](LICENSE). Use it, modify it, and build your
own worlds on it freely.

**The worlds are not.** The Experience content — the original worlds,
characters, settings, and narrative shipped in this repository — is **©
2026 Sanish Gyawali, all rights reserved**, and is *not* covered by the MIT
License. You may play it and learn the format from it, but you may not
redistribute or reuse the story IP itself. The MIT grant covers the software,
not the fiction it runs.
