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

The world is a **fixed-size 2D grid of regions, each nesting one or more
nodes** (the actual visitable locations). Schema defined in
`src/data/schemas/world.ts` (Zod).

- **Region** — a grid cell, the macro unit of travel. Has a `position {x, y}`
  on the world grid, its own `worldType`, and nests an array of `nodes`.
  - `worldType` — `narrative-bound` (fixed path), `semi-open` (bounded
    freedom), or `open` (fully open). *(Mechanics of each type deferred.)*
- **Node** — a single visitable location nested inside a region. Carries a
  `localPosition {x, y}` within the region's **unbounded** local sub-grid (no
  declared sub-grid size), and an optional `layer` (z-index) to disambiguate
  multiple nodes stacked at the same local position (e.g. surface vs.
  basement).
- **Edge** — a connection from one node to another (`targetNodeId`).
  Direction between nodes is **computed**, not authored — every node has an
  effective world-space position (`region.position` combined with
  `node.localPosition`), so `scope/` derives direction (north/south/etc.) the
  same way at both the region level and the node level. An edge's optional
  `direction` field is only an override, for non-geometric links (e.g. a
  portal) where computed direction wouldn't make narrative sense.
- **Why direction is engine-computed, not AI-inferred:** LLMs are unreliable
  at consistent spatial reasoning across a long session. Direction must be a
  fact `scope/` hands the AI, never something left for the AI to work out or
  remember on its own.
- **Environmental codes** — structured objects (not flat tags), each with:
  - `category` — open string, not a fixed enum (e.g. `"climate"`, `"hazard"`,
    `"lighting"`) — left open since categories vary by setting.
  - `value` — the specific descriptor (e.g. `"cold"`, `"toxic"`).
  - `severity` — 1–5 intensity scale.
  - `mechanical` — per-code flag; some codes are gameplay-affecting, others
    are narrative flavor only.
  - `effectId` — required when `mechanical` is true; references an effect
    that `rules/` resolves. The effect's actual logic lives in `rules/`, not
    in world data, keeping content decoupled from rule implementation.
  - `description` — optional flavor text for narration.
  - **Merge behavior:** a node's codes merge with its region's, keyed by
    `(category, value)` — a node entry overrides the region's matching
    entry; anything not declared on the node inherits from the region
    unchanged.
- World-level data integrity is enforced at validation time: region positions
  must fall within the world's bounds, region and node IDs must be unique
  (node IDs globally, since edges can cross regions), and every edge must
  resolve to a real node.

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

### Model Loading: SAL & MML

The tier system above defines *how many model roles* exist. Separately, the
engine needs a strategy for *how those roles are backed in memory* —
multiple specialized models don't require multiple models loaded at once.

- **SAL (Smart Auto Loading)** — one model resident at a time. Model A loads,
  performs its job (e.g. reasoning/validation/tool-calling), hands its output
  to the engine as context, then unloads. Model B then loads, picks up that
  context, and performs its job (e.g. narrative). The engine brokers the
  handoff — it already mediates everything between AI and state, so passing
  context between sequential loads is a natural extension of that role.
  Trades load/unload latency for enabling multi-model specialization on
  hardware that can't hold multiple models in RAM at once (constrained,
  offline, mobile).
- **MML (Multi Model Loading)** — multiple models loaded simultaneously, each
  its own instance, running in parallel. No swap overhead, but requires
  enough RAM/VRAM to hold all of them at once. Primarily backend/server, but
  usable offline too if hardware allows.

**Selection is automatic by default, overridable by engine constant** — same
pattern as the tier cap and the per-job `rules/` override. By default the
engine detects available RAM against cumulative model footprint and picks SAL
or MML accordingly; an engine constant can force one strategy regardless of
detected capability.

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

- Mechanics of `narrative-bound` / `semi-open` / `open` world types
- DTM storage format and query interface
- Initial `tools/` check/action set definitions
- Data file format for Character/Ruleset/other Experience content (world data
  uses JSON + Zod, per `src/data/schemas/world.ts` — other content types TBD)
- Confirmed job-to-model mapping at each tier (1–5)
- Engine constant configuration schema (global cap + per-job overrides)
- Hardware capability detection method
- RAM/VRAM threshold logic for automatic SAL vs MML selection
- Context handoff format passed between models in SAL
- `effectId` vocabulary and how `rules/` resolves/registers effects
