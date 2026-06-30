# Architecture Document: Genesis Infinity

> **Status:** a beta vertical slice is implemented (see **Beta Implementation**
> below) — every layer exists end-to-end behind a CLI, running on a single
> local model. The rest of this document still describes the full target
> design; sections below are the concept-level spec, and the beta section
> notes where the current build narrows or defers part of that spec.

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
    freedom), or `open` (fully open). See **World Type Mechanics** below.
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

#### World Type Mechanics

- **`narrative-bound`** — linear progression, driven heavily by
  timestamp/trigger-based plot points (the firing-mechanism axis from
  **Narrative / Plot Points** below). Day/night cycle is a per-Experience
  config choice: some narrative-bound Experiences run one, others have none
  at all (time is effectively static/frozen throughout) — not a runtime
  pause, just an authoring decision.
- **`semi-open`** — bounded freedom: branching plot points (multiple paths/
  outcomes, not a single fixed line), with an active day/night cycle.
- **`open`** — fully open: no fixed plot, the player can act freely for as
  long as the character is alive. The AI can generate new plot points and
  NPC stories on the fly. Once generated, these are written once to a
  **separate generated-content store** (distinct from `dtm/`, queried by
  `data/` alongside authored content) so they're available for consistency/
  reference in later turns — but they remain **soft-coded**: the AI keeps
  interpretive freedom around them going forward, the store isn't a hard
  lock-in the way a hardcoded plot point is.

### Characters

- **Personality** and **tone** — drive how the AI voices the character.
- **Plot points**, timecoded — a timeline of character-specific narrative beats.
- **Stats and skills** — the mechanical layer, used by `rules/` for checks.
  Defined as a `CharacterSheet` in `src/data/schemas/character.ts` (Zod),
  separate from the narrative fields above (combined into a full Character
  entity in a later pass):
  - **Abilities** — D&D-style baseline (STR/DEX/CON/INT/WIS/CHA) provided as
    a template (`DEFAULT_ABILITIES`), but overridable/extensible per
    Experience — not a fixed enum.
  - **Skills** — D&D-style baseline list (~18 skills, each referencing a
    governing ability id) provided as a template (`DEFAULT_SKILLS`), also
    overridable/extensible per Experience.
  - **Class / race / background** — open strings, not fixed enums, so
    non-fantasy settings aren't forced into D&D-specific content.
  - **No derived-stat formulas** — ability scores, skill values, hit points,
    and armor class are all raw stored values. There's no D&D-style
    modifier/proficiency formula baked into the schema; if `rules/` needs a
    derived value, it computes one at resolution time.
  - Validation: ability and skill IDs must be unique within a sheet, and a
    skill's `governingAbilityId` must reference a real ability on that sheet.

#### Ruleset Declaration & Fallback

An Experience can declare its own ability/skill *definitions* (id + name,
and for skills, an optional `governingAbilityId`) — this is the ruleset
template a character's abilities/skills draw their ids from, distinct from
a character's own stored scores/values.

- Schema: `ExperienceSchema` in `src/data/schemas/experience.ts` (Zod),
  currently scoped to just `abilities`/`skills` declarations — the full
  Experience model (world, characters, rulesets, mode) is deferred.
- Resolution is **per-entry fallback**, in `src/data/loaders/character.ts`:
  each declared ability/skill entry is validated individually; an invalid
  or duplicate-id entry is dropped rather than failing the whole list. Any
  default id (`DEFAULT_ABILITIES` / `DEFAULT_SKILLS`) missing from the
  resolved set is filled in from the default. A skill entry whose
  `governingAbilityId` doesn't match any resolved ability id is also
  treated as broken and dropped.
- This keeps the ruleset truly data-driven (an Experience can fully
  override or extend the D&D baseline) while guaranteeing a usable,
  internally-consistent result even if part of the declared data is
  malformed.

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

#### Storage Format

- **SQLite** — a single embedded file DB. Works natively on desktop/server
  (and offline); a web target would need a WASM build (e.g. sql.js) or a
  backend proxy, deferred until web support is built.
- **Schema:** a single `dtm_events` table — typed common columns for fields
  every event shares (queryable/indexable), plus a `payload` JSON column
  for event-type-specific extras:

  | Column | Type | Notes |
  |---|---|---|
  | `id` | INTEGER PK | autoincrement, ordering tiebreaker |
  | `experience_id` | TEXT | scopes events to a single Experience/playthrough |
  | `timestamp` | INTEGER | in-game/engine time, not wall clock |
  | `type` | TEXT | open string event type, e.g. `"entity.moved"`, `"action.applied"` — concrete vocabulary TBD alongside `tools/` |
  | `entity_id` | TEXT, nullable | character/NPC/item the event concerns, if any |
  | `node_id` | TEXT, nullable | node the event occurred at, if applicable |
  | `position_x` / `position_y` | INTEGER, nullable | for entity/item position-update events |
  | `payload` | TEXT (JSON) | event-type-specific extra data |

  Indexed on `experience_id`, `timestamp`, `entity_id`, and `type` for the
  query patterns `state/` and `ai/` summarization need (e.g. "everything
  for this character since timestamp X").
- **Query interface:** `src/dtm/index.ts`'s `Dtm` class wraps Node's built-in
  `node:sqlite` (`DatabaseSync`) directly — no ORM. Exposes `append`,
  `allForExperience`, `forEntity`, `recent`, and `lastPosition` (the last
  position-bearing event for an entity, used by `state/` to derive current
  location).

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
   - **Beta deviation:** the cap is not enforced. `ai/` uses
     node-llama-cpp's `session.prompt({functions})`, which drives the whole
     check-tool loop internally with no hook to count or cap rounds. Beta
     ships without manual round-counting, relying on the model's own
     judgment and the implicit token budget; revisit if it loops badly once
     there's a model to test against.
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

## Beta Implementation

A working vertical slice exists end-to-end: every engine layer in the
diagram above is built, wired together, and playable via a CLI. This section
documents what's actually implemented and where it narrows the concept-level
design above for beta scope.

### Scope

- **Model loading:** Tier 1 only — a single local model, loaded once via
  `node-llama-cpp`, handles narrative, tool-call decisions, and rule
  validation. The Tier 2–5 specialized-model split and the SAL/MML loading
  strategies above are not implemented; beta always loads one model and
  keeps it resident for the session.
- **Model backend:** `node-llama-cpp`, pointed at a user-supplied local GGUF
  model path (`--model <path>` CLI arg). No other backend is wired in.
- **Package manager / runtime:** npm, TypeScript executed via `tsx` (no
  build step in beta).

### Engine layers, as built

- **`data/`** (`src/data/`) — Zod schemas (`schemas/`) and loaders
  (`loaders/`) for `Experience`, `World`, and `CharacterSheet`, per the
  Experience Model and World sections above. `loadExperience(dir)` reads
  `experience.json`, `world.json`, and `characters/*.json` from an
  Experience directory and resolves the ruleset per the fallback rules
  described above.
  - **Character starting positions:** `ExperienceSchema` gained a
    `characters: CharacterPlacementSchema[]` field
    (`{characterId, startingNodeId}`), since `state/` needs a fallback
    position before any `entity.moved` dtm event exists for a character.
- **`dtm/`** (`src/dtm/index.ts`) — implements the `dtm_events` schema above
  via `node:sqlite`'s `DatabaseSync`, with no ORM (see DTM section above for
  the resolved query interface).
- **`state/`** (`src/state/index.ts`) — `getState(dtm, loaded)` returns a
  `StateSnapshot`: every character's sheet plus current `nodeId`, derived by
  reading each character's most recent position-bearing dtm event
  (`dtm.lastPosition`), falling back to the Experience's declared
  `startingNodeId` if none exists yet. Confirms the "state is a derived
  view, never independently stored" principle above.
- **`scope/`** (`src/scope/index.ts`) — `getScope(world, state, characterId)`
  returns a character's current node (merged environmental codes per the
  node-overrides-region rule above, and connections with **computed**
  direction), plus which other characters are co-located
  (`othersPresent`). Direction is an 8-point compass computed from
  same-region local-position deltas, or region-position deltas when
  comparing nodes across regions (local sub-grids are unbounded and not
  comparable cross-region); two nodes at the same position on different
  layers resolve to `"up"`/`"down"`. An edge's authored `direction`
  override, when present, still wins over the computed value.
- **`tools/`** (`src/tools/index.ts`) — the beta check + action tool set:
  - `get_scope` (check) — wraps `scope/`'s `getScope`.
  - `get_character_sheet` (check) — looks up a loaded character's sheet.
  - `get_recent_dtm` (check) — wraps `dtm.recent`.
  - `move` (action) — validates the target node is reachable (connected by
    an edge) from the character's current node, then appends an
    `entity.moved` event to `dtm/`. Returns `{success: false, reason}`
    rather than throwing on an invalid target.
- **`rules/`** (`src/rules/index.ts`) — `RuleValidator` implements the
  "separate validation prompt" approach: its own `LlamaChatSession` on a
  dedicated `LlamaContextSequence` (sharing the loaded model/context with
  the narrative session, but not its chat history), reset before every
  call so each validation is stateless. The model's response is forced into
  `{valid: boolean, reason: string}` via a grammar built from
  `llama.createGrammarForJsonSchema`. Currently only `ai/`'s `move` handler
  calls it, ahead of invoking `tools/`'s `move`.
- **`ai/`** (`src/ai/index.ts`) — `createAiSession(...)` loads the model,
  opens one `LlamaContext`, and draws two sequences from it: one for the
  narrative `LlamaChatSession`, one for `rules/`'s `RuleValidator`. Declares
  the four tools above via `defineChatSessionFunction` and drives the
  agentic loop through `session.prompt(input, {functions})` (see the Turn
  Flow beta deviation above re: the uncapped loop). Each tool handler is
  wrapped by a `record()` helper that invokes an optional
  `onToolCall?: (call) => void` callback — this is how `io/`'s debug-dump
  mode observes tool calls without `ai/` depending on `io/`.
- **`core/`** (`src/core/index.ts`) — `createEngine(options)` assembles a
  playable Experience: loads data, opens `dtm/`, starts the `ai/` session,
  and exposes `takeTurn(input)`, which increments a per-turn timestamp
  counter and forwards to `ai/`. This counter is "engine time" per the DTM
  section above — a simple incrementing count, not wall-clock time.
- **`io/`** (`src/io/cli.ts`) — a CLI chat loop (`npm run play`) combining
  play and an AI-perception inspector:
  `--experience <dir> --model <path> --character <id> [--db <path>] [--debug]`.
  With `--debug`, prints the named character's `scope/` view before and
  after each turn, plus every tool call made during that turn.
  - **Player-character identification:** `ExperienceSchema` has no
    `mode`/`playerCharacterId` field yet (per the Open/Deferred "mode"
    item below); `io/` takes `--character <id>` as a CLI argument instead,
    keeping this a runtime/session concern rather than Experience-authored
    data.

### Test Experience: Goku vs Venom — Null Void Showdown

`examples/goku-vs-venom/` is the smoke-test fixture for the beta slice: Goku
and Venom (D&D-range stats, 10–20) placed in Ben 10's Null Void dimension —
one `open`-type region (`null-void-expanse`) with two connected nodes
(`battlefield-core`, `drifting-wreckage`). The Experience declares no custom
abilities/skills, exercising the default-ruleset fallback path. Verified via
ad hoc scripts (not a checked-in test suite yet) that `loadExperience`,
`getState`, `getScope`, and `moveTool` interoperate correctly: starting
positions resolve from the Experience's declared placements, scope reports
correct connections/direction/`othersPresent`, a valid move updates `dtm/`
and is reflected in the next `getState`/`getScope` call, and an invalid
move target fails gracefully instead of throwing.

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

- Generated-content store format/interface (AI-authored plot points/NPC
  stories in `open` worlds — separate from `dtm/`)
- Bounded check-tool-call loop (the `X` cap in Turn Flow) — not enforced in
  the beta `ai/` implementation, see Beta Implementation above
- `mode` / `playerCharacterId` on `ExperienceSchema` — beta resolves player
  identification via a CLI arg instead, see Beta Implementation above
- Tier 2–5 specialized-model splits and the SAL/MML loading strategies —
  beta only implements Tier 1 (single model)
- Data file format for Ruleset/other Experience content (world data uses
  JSON + Zod per `src/data/schemas/world.ts`; character mechanical data uses
  JSON + Zod per `src/data/schemas/character.ts` — other content types TBD)
- Full Character entity combining CharacterSheet (stats/skills) with the
  narrative fields (personality, tone, timecoded plot points)
- Confirmed job-to-model mapping at each tier (1–5)
- Engine constant configuration schema (global cap + per-job overrides)
- Hardware capability detection method
- RAM/VRAM threshold logic for automatic SAL vs MML selection
- Context handoff format passed between models in SAL
- `effectId` vocabulary and how `rules/` resolves/registers effects
