# Architecture Document: Genesis Infinity

> **Status:** concept — engine not yet implemented. Captures the architecture
> decisions made so far. Several details are intentionally deferred (marked
> below) and will be expanded in later passes.

## Core Design Principle

Genesis Infinity is a **plug-and-play, data-driven AI RPG engine**. Developers
supply data (rulesets, world, characters, content) — not code — to build a
playable experience.

The AI acts as **game master, narrator, and gap-filler**, but the engine is the
single authority over what is true in the game. The AI proposes; the engine
validates and applies. This mirrors the "single, auditable policy core" pattern
used in Domain AI, where nothing reaches or comes from the AI without passing
through the engine's enforcement layer.

---

## Experience Model

An **Experience** is the full data package for a playable instance. It bundles:

- **Characters**
- **World**
- **Location metadata**
- **Rulesets**
- **Mode** — single-player or multiplayer, set as a config field on the
  Experience (not a separate engine codepath)
- Extensible — additional content types may be added later

### World

- Modeled as an **array of location entries**, each carrying environmental
  codes (climate, hazards, conditions — exact schema deferred).
- Classified by **type**:
  - `narrative-bound` — fixed path
  - `semi-open` — bounded freedom
  - `open` — fully open
  - *(Mechanics of each type deferred to a later pass.)*

### Characters

- **Personality** and **tone** — drive how the AI voices the character.
- **Plot points**, timecoded — a timeline of character-specific narrative beats.
- **Stats and skills** — the mechanical layer, used by `rules/` for checks.

### Narrative / Plot Points

Plot points vary along two independent axes:

| Axis | Values |
|---|---|
| Authoring style | `hardcoded` (fixed, deterministic) or `soft-coded` (AI has interpretive freedom within bounds) |
| Firing mechanism | `trigger-based` (fires on a condition/event) or `timestamp-based` (fires at a specific point in the timeline) |

A plot point can combine any pairing (e.g. hardcoded + triggered, soft-coded +
timestamped).

---

## Memory

Memory is split into two distinct mechanisms:

### DTM — Data Tracking Mechanism

The engine's memory system. An **append-only, timestamped log of everything**:
every change, every entity/item position update, every action taken. This is
an event-sourcing pattern — DTM is the single source of truth.

### State

The **current snapshot** of the game (what's true right now). State is a
**derived view**, computed from DTM rather than independently maintained.

### Summarization

Scoped narrowly, for now, to **character background story only** — compresses
a character's timecoded plot points into a digest for use in narration. Reads
from DTM, filtered to that character. (General game-history summarization is
not in scope yet.)

---

## Engine Layers

```
io/          chat interface (input/output)
core/        turn loop, session/event dispatch
dtm/         append-only timestamped log: every change, every entity/item position
state/       current snapshot, derived from dtm/
data/        loads world/rules/content from data files
rules/       validates tool calls against constraints + dtm/state before they apply
ai/          builds prompts (scene/tone), exposes tool definitions, character summarization
tools/       the defined action set (move, attack, check_stat, etc.) the AI can invoke
```

## Turn Flow

1. `ai/` builds the scene/tone context and sends it to the model along with
   available tool definitions.
2. The model replies with narration and, optionally, a tool call.
3. `rules/` validates the tool call against current `state/`, `dtm/` history,
   and the Experience's data constraints.
4. If valid: `core/` applies the action, the change is written to `dtm/`, and
   `state/` reflects it as a derived view.
5. If invalid: the AI is told why, and must adjust its response.

This keeps the engine as the authority over every change — the AI cannot alter
game state directly, only propose actions through `tools/`.

---

## Platform & Language

- **Language:** TypeScript, for cross-platform deployment (web, desktop,
  server) from a single codebase.
- **AI is orchestration, not ML research** — the engine calls LLM APIs and
  enforces structure around responses; it does not train or fine-tune models.
- **Offline / on-device inference** is deferred. [Domain AI](https://github.com/gyawalisanish0/DomainAI)
  (Android, on-device llama.cpp) is a candidate future pluggable backend behind
  the `ai/` abstraction for mobile offline support — not built into Genesis
  Infinity itself.

---

## Open / Deferred

- World environmental code schema
- Mechanics of `narrative-bound` / `semi-open` / `open` world types
- DTM storage format and query interface
- Initial `tools/` action set definitions
- Data file format for Experience packages (JSON, YAML, etc.)
