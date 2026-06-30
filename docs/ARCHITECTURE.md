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
core/        turn loop — drives the check → act → narrate cycle
scope/       computes what's in-scope for the AI this turn, based on settings
             and the character's current location (drives immersion)
dtm/         append-only timestamped log: every change, every entity/item position
state/       current snapshot, derived from dtm/
data/        loads world/rules/content from data files
rules/       validates action-tool calls against constraints + dtm/state
ai/          drives the agentic loop, builds prompts (scene/tone), character
             summarization
tools/       check tools (read-only) + action tools (write) the AI can invoke
```

## Turn Flow

Genesis Infinity uses an **agentic loop**, not a single-shot prompt/response —
the AI can ground itself via read-only checks before committing to narrative
or mechanical action, similar to how Claude Code inspects before acting.

1. `scope/` computes what's currently visible/relevant to the AI: the
   character's location, what's around them, applicable rules, and which
   tools are contextually available.
2. `ai/` drives a **bounded loop**: the model may call **check tools**
   (read-only — query state, rules, dtm, character data) up to a maximum of
   `X` calls.
   - `X` is a setting on the Experience package, not a global constant — a
     simple Experience can cap low, a complex one can allow more.
3. The model commits to either narration, or an **action tool** call (write
   — move, attack, etc.).
4. Tool-call output is **syntax/structure validated** before reaching
   `rules/`. For local models this leans on grammar-constrained decoding
   (e.g. llama.cpp GBNF) to force valid structure at generation time; engine-
   side validation catches the rest regardless of model.
5. `rules/` validates the action against current `state/`, `dtm/` history,
   and the Experience's data constraints.
6. If valid: `core/` applies the action, the change is written to `dtm/`, and
   `state/` reflects it as a derived view.
7. If invalid: the AI is told why, and must adjust its response.

This keeps the engine as the authority over every change — the AI cannot alter
game state directly, only propose actions through `tools/`.

---

## AI Orchestration & Model Allocation

The number of models used to run an Experience **scales with hardware
capability**, from 1 up to 5:

- **Tier 1 (constrained hardware)** — a single small model handles every job
  in sequence: narrative, tool-call/check decisions, summarization, scope
  description.
- **Tier 5 (capable hardware)** — each job runs on its own specialized model.
  Candidate split (to be confirmed as jobs are implemented):
  1. Narrative/prose — storytelling, character voice
  2. Tool-call/check decisions — agentic loop control
  3. Character summarization — background story digestion (from DTM)
  4. Scope/immersion description — environmental detail
  5. Rule/constraint reasoning — see note below

**Hardware sets the ceiling; engine constants set the operating point.**
Capability detection determines the maximum feasible tier, but:
- A **global engine constant** can cap the tier below what hardware could
  support (e.g. force fewer models even on capable hardware).
- **Per-job constants** can override independently of the global tier — e.g.
  `rules/` can be pinned to deterministic-only (no model involved) regardless
  of how many models everything else is using.

**Small/offline model considerations** (e.g. Mistral, Gemma, Phi-mini class
models intended for local/llama.cpp execution):
- These models vary in strength by job — e.g. Phi-mini-class models tend to
  be stronger at structured tool-calling than at narrative prose. This is
  part of the motivation for splitting jobs across specialized models at
  higher tiers, rather than asking one small model to do everything well.
- Open-ended self-directed looping (the model deciding for itself how many
  checks to make) degrades at small-model scale — the bounded loop (`X` cap)
  exists in part to keep this reliable across model sizes.

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
- Initial `tools/` check/action set definitions
- Data file format for Experience packages (JSON, YAML, etc.)
- Confirmed job-to-model mapping at each tier (1–5)
- Engine constant configuration schema (global cap + per-job overrides)
- Hardware capability detection method
