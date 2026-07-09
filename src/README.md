# `src/` — the engine

The Genesis Infinity engine. TypeScript, run directly with `tsx` (no build
step). Each subdirectory is one module with a single responsibility; they
compose into the turn loop that `core/` orchestrates.

For the full design, read **[docs/BACKEND_ARCHITECTURE.md](../docs/BACKEND_ARCHITECTURE.md)**
— this is a map, not a spec.

## The shape of a turn

A player (or an autonomous NPC) attempts something. The engine assembles what
the model is allowed to see (`scope/`), lets the model act through gated
tools (`tools/`), validates each attempted action against the rules
(`rules/`), applies the mechanical result as events (`dtm/`), re-derives the
world state (`state/`), checks the narration for consistency (`audit/`), and
returns the narrated outcome.

Nothing about the world is stored as mutable "current" data: positions, hit
points, and inventory are **derived** by replaying the event log. The
character sheet is the static starting snapshot; play only ever appends
events.

## Module map

| Module | Responsibility |
|---|---|
| `data/` | Zod schemas + loaders for Experience packages (world, characters, ruleset). |
| `dtm/` | The event log — an append-only JSON record ("what happened"). |
| `state/` | Derives current world state (positions, HP, inventory, active effects) from the event log. |
| `scope/` | Builds the AI-visible payload for a turn — only what the acting character can perceive. |
| `tools/` | The gated tool/action definitions the model calls (move, use technique, interact, say, checks). |
| `rules/` | Model-routed action validator — judges each attempt valid / neutral / invalid, with difficulty tiers and DCs. |
| `ai/` | The LLM turn loop (agentic tool-calling) and the pluggable driver abstraction (local + API backends). |
| `audit/` | Narration consistency checker — catches narration that contradicts what actually resolved. |
| `summarizer/` | Context rollup, keeping long sessions within the model's window. |
| `timeline/` | Wall-clock-anchored "timeline unit" counter that effect durations and beats are measured in. |
| `scheduler/` | Drives autonomous NPC turns and broadcasts turn/your-turn events. |
| `packages/` | Experience package discovery, `.zip` import, and custom-character creation. |
| `core/` | The `Engine` — wires all of the above together and runs one turn end-to-end. |
| `io/` | The terminal chat loop (`npm run play`). |
| `server/` | The HTTP API wrapping the Engine — SSE turn streaming, runtime model picker (`npm run serve`). |

## Backends

`ai/` talks to models through one `LlmDriver` interface, implemented twice:
`llamaCppDriver` (a local GGUF model via node-llama-cpp) and `apiDriver` (any
OpenAI-compatible HTTP API). The rest of the engine never knows which is in
use.
