# Backend Architecture Document: Genesis Infinity

> See `docs/FRONTEND_ARCHITECTURE.md` for the static web UI (`frontend/`)
> that talks to the `server/` HTTP API documented below.

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
  - **Techniques** — named things a character actually knows how to do
    (`TechniqueDefSchema`: `{id, name, description, effectId?}`), declared
    per-character with no ruleset-level template or default list (unlike
    abilities/skills, which are Experience-wide). This is the hard
    capability gate for `tools/`'s `use_technique` action: a character can
    only attempt a technique on their own list — checked structurally,
    before the attempt ever reaches `rules/` (see Beta Implementation
    below). The optional `effectId` references the ruleset's effect pool
    (see Escalation Effects below) — a technique's pre-authored mechanical
    consequence on its target when it fully lands (see Effects &
    Mechanical Grounding below).
  - **Inventory** — unlike techniques, items *are* Experience-wide (an
    `ItemDefSchema` catalog, like abilities/skills/effects), since items
    are usually generic — "Health Potion" means the same thing for every
    character who carries one. A character's sheet just carries quantities
    (`InventoryEntrySchema`: `{itemId, quantity, equipped?}`) referencing
    that catalog. This is the hard capability gate for `interact`'s
    optional `itemId`: a character can only use an item they actually
    carry with `quantity > 0` — see Ruleset Declaration & Fallback below
    and `tools/` in Beta Implementation.
  - **Class / race / background** — open strings, not fixed enums, so
    non-fantasy settings aren't forced into D&D-specific content.
  - **No derived-stat formulas** — ability scores, skill values, hit points,
    and armor class are all raw stored values. There's no D&D-style
    modifier/proficiency formula baked into the schema; if `rules/` needs a
    derived value, it computes one at resolution time.
  - Validation: ability, skill, technique, and inventory item IDs must each
    be unique within a sheet, and a skill's `governingAbilityId` must
    reference a real ability on that sheet.

#### Ruleset Declaration & Fallback

An Experience can declare two kinds of ruleset content, both optional and
both falling back to engine defaults if absent:

- **Definitions** — id-keyed lists a character's own data draws its ids
  from: ability/skill *definitions* (id + name, and for skills an optional
  `governingAbilityId`), effect *definitions* for escalation (id + name +
  description + `severity` + stat deltas — see **Escalation Effects**
  below), and item *definitions* for inventory (id + name + description +
  `type` + effect fields — see **Item Catalog & Inventory** below).
- **Escalation tuning** — flat settings for `tools/`'s escalation system
  itself (how many strikes before punishment, how harsh, how long it
  lasts) — see **Escalation Config** below.

Both are distinct from a character's own stored scores/values, which live
on the `CharacterSheet` itself, not the Experience.

- Schema: `ExperienceSchema` in `src/data/schemas/experience.ts` (Zod),
  currently scoped to `abilities`/`skills`/`effects`/`items`/`escalation`
  declarations — the full Experience model (world, characters, rulesets,
  mode) is deferred.
- Ability/skill/effect/item resolution is **per-entry fallback**, in
  `src/data/loaders/character.ts`: each declared entry is validated
  individually; an invalid or duplicate-id entry is dropped rather than
  failing the whole list. Any default id (`DEFAULT_ABILITIES` /
  `DEFAULT_SKILLS` / `DEFAULT_EFFECTS` / `DEFAULT_ITEMS`) missing from the
  resolved set is filled in from the default. A skill entry whose
  `governingAbilityId` doesn't match any resolved ability id is also
  treated as broken and dropped (effects/items have no such
  cross-reference to check).
- Escalation config resolution is **per-field fallback** instead (it's a
  flat settings object, not an id-keyed list) — see Escalation Config
  below.
- This keeps the ruleset truly data-driven (an Experience can fully
  override or extend the D&D baseline, the default effect pool, the
  default item catalog, and the default escalation tuning) while
  guaranteeing a usable, internally-consistent result even if part of the
  declared data is malformed or absent.

##### Escalation Effects

`EffectDefSchema` (`src/data/schemas/character.ts`) is the ruleset-level
definition for a mechanical effect: `{id, name, description, severity (1-5,
same scale as `EnvironmentalCode`), armorClassDelta?, maxHitPointsDelta?,
currentHitPointsDelta?}`. `DEFAULT_EFFECTS` provides three fallback entries
(`exposed`/severity 1, `weakened`/severity 2, `battered`/severity 3).
`severity` isn't just descriptive — it gates which effects `tools/`'s
`rejectAction` is allowed to draw from as a character's strike count rises
(see Beta Implementation below). `currentHitPointsDelta` is the damage/heal
primitive — see Effects & Mechanical Grounding below for why it's a
different kind of delta from `armorClassDelta`/`maxHitPointsDelta`.

##### Item Catalog & Inventory

`ItemDefSchema` (`src/data/schemas/character.ts`) is the ruleset-level
catalog entry: `{id, name, description, type: "consumable" | "equipment",
armorClassDelta?, maxHitPointsDelta?, healAmount?}`. Deliberately a flat
schema (not a discriminated union) for consistency with `EffectDefSchema`
— fields are only meaningful for the `type` they document, by convention
rather than schema-enforced separation:
- `"consumable"` — `healAmount`, if set, is applied once, instantly, to
  current HP when used, then the item's quantity is decremented. This is
  permanent, unlike escalation debuffs/hazards — there's no decay/expiry
  for a heal.
- `"equipment"` — `armorClassDelta`/`maxHitPointsDelta` apply as a
  standing modifier for as long as the item is equipped, toggled on each
  use and removed the instant it's unequipped. Not time-based at all,
  unlike escalation/hazard debuffs.

`DEFAULT_ITEMS` provides two fallback entries: `health-potion`
(consumable, `healAmount: 20`) and `iron-shield` (equipment,
`armorClassDelta: 2`). A character's `CharacterSheet.inventory` is an
array of `InventoryEntrySchema` (`{itemId, quantity, equipped?}`)
referencing this catalog by id — see **Inventory** under Characters above,
and `tools/`/`state/` in Beta Implementation for how quantity/equipped
state is actually derived and applied.

##### Escalation Config

`EscalationConfigSchema` (`src/data/schemas/experience.ts`) tunes
`rejectAction` itself: `{strikeThreshold?, maxSeverity?, debuffDurationUnits?}`,
all optional. `debuffDurationUnits` is in `timeline/` units (see `timeline/`
below in Beta Implementation) — real-wall-clock-anchored, not turn count.
Each field falls back independently to `DEFAULT_ESCALATION_CONFIG`
(`{strikeThreshold: 3, maxSeverity: 5, debuffDurationUnits: 60}` — 60 units
is 30 real seconds at 2 units/sec) if the Experience doesn't declare it —
declaring only one field (e.g. a stricter `maxSeverity` cap) doesn't
require redeclaring the others. Resolved once per load into
`LoadedExperience.escalation` (a sibling of `ruleset`, since it's tuning
parameters rather than declarable ruleset content) by
`data/loaders/experience.ts`'s `resolveEscalationConfig`.

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
  | `type` | TEXT | open string event type — beta's vocabulary (see Beta Implementation below): `"entity.moved"`, `"technique.used"`, `"character.interacted"`, `"character.said"`, `"action.rejected"`, `"debuff.applied"`, `"hazard.noted"`, `"turn.audited"`, `"item.consumed"`, `"item.toggled"` |
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
   - **Beta addition:** state correctness (steps 4–7) is a closed
     guarantee — the AI cannot make `dtm/` say anything but the truth. What
     it *narrates* about that truth is a separate concern, since generated
     prose isn't grammar-constrained the way tool calls are. Beta adds an
     `audit/` step after narration is produced: a `NarrationAuditor` checks
     the narration against the turn's actual tool results, and on a
     detected contradiction, `ai/` reprompts for a corrected version
     (bounded retries) before falling back to a deterministic, tool-
     result-only sentence. See `audit/`/`ai/` in Beta Implementation.

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

- **Model loading:** Tier 1 only — a single model handles narrative,
  tool-call decisions, and rule validation. The Tier 2–5 specialized-model
  split and the SAL/MML loading strategies above are not implemented; beta
  always loads one model (or opens one API-backed connection) and keeps it
  resident for the session.
- **Model backend: pluggable.** `ai/`'s turn loop, `rules/`'s
  `RuleValidator`, and `audit/`'s `NarrationAuditor` all depend on a shared
  `LlmDriver` interface (`src/ai/llmDriver.ts`) rather than on
  `node-llama-cpp` directly, so the engine can run against either backend
  without touching their logic:
  - `llamaCppDriver.ts` — a local GGUF model via `node-llama-cpp`
    (`--model <path>` CLI arg, `--backend llamaCpp`, the default).
  - `apiDriver.ts` — any OpenAI-compatible chat completions API (Hugging
    Face Inference Providers, OpenRouter, etc.) via `--backend api
    --api-base-url <url> --api-model <id> --api-key-env <ENV_VAR_NAME>`.
    The key itself is never a CLI argument — only the name of an
    environment variable holding it. Since a raw HTTP chat completions API
    doesn't run a tool-calling loop for you (unlike `LlamaChatSession`,
    which drives the whole thing internally), `apiDriver.ts` reimplements
    that loop manually: call the API, execute any requested tool calls,
    feed results back as `role: "tool"` messages, repeat until the model
    responds with plain text (capped at `maxToolRounds`, default 8, since
    we now own this loop instead of node-llama-cpp owning it internally).
    Structured JSON output (used by `RuleValidator`/`NarrationAuditor`)
    tries strict `response_format: json_schema` first, falling back to a
    looser `json_object` request with the schema described in the prompt
    text if the provider/model doesn't honor strict mode — not every model
    supports forced structured output the way GBNF grammars force it
    locally, so this is treated as a real, model-dependent reliability gap
    rather than assumed universal.
  See `ai/`, `rules/`, and `audit/` below for how each depends on
  `LlmDriver` rather than `node-llama-cpp` specifically.
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
- **`state/`** (`src/state/index.ts`) — `getState(dtm, loaded, world,
  currentTurn, currentTimelineUnit)` returns a `StateSnapshot`: every
  character's sheet, current `nodeId` (derived from `dtm.lastPosition`,
  falling back to the Experience's declared `startingNodeId`),
  `activeDebuffs` — non-expired `AppliedDebuff`s (an `EffectDef` plus
  `appliedAtUnit`/`expiresAtUnit`, `timeline/` units — real-wall-clock-
  anchored, not turn count) derived from `debuff.applied` dtm events,
  filtered by `expiresAtUnit > currentTimelineUnit` — `inventory`, the
  sheet's starting `InventoryEntry`s with `quantity` decremented by each
  `item.consumed` event and `equipped` flipped by each `item.toggled`
  event (`currentInventory`, the same "sheet is static, state is derived"
  pattern as position/debuffs) — `effectiveStats`, `computeEffectiveStats`'s
  result: the sheet's `armorClass`/`hitPoints` with `activeDebuffs`' *and
  currently-equipped items'* deltas summed in (max HP floored at 0,
  current HP clamped to the effective max), plus any cumulative healing
  from `item.consumed` events (`totalHealingReceived` — permanent, not a
  decaying effect, snapshotting `healAmount` into the event payload at
  consumption time so this doesn't need to re-look the item up in a
  possibly-changed catalog) — and `environmentalCodes`, the current node's
  merged codes (via `findNode`/`mergeEnvironmentalCodes`, both moved to
  `data/schemas/world.ts` so `state/` can call them without depending on
  `scope/`, which itself depends on `state/`'s types — importing them from
  `scope/` would have created a cycle). Confirms the "state is a derived
  view, never independently stored" principle above. The effect pool
  itself lives in `loaded.ruleset.effects`, and the item catalog in
  `loaded.ruleset.items` (both Experience-resolved, see Ruleset
  Declaration & Fallback above) rather than as `state/`-owned constants.
  Computing `effectiveStats` in `state/` rather than leaving `rules/` to
  sum deltas out of `activeDebuffs`/`inventory` itself follows the same
  principle as `scope/`'s computed direction below: a fact the engine
  hands the AI, not something left for it to derive. `environmentalCodes`
  is included so `rules/`'s tri-state judgment can factor hazards into
  valid/neutral/invalid decisions. `currentTimelineUnit` is used only for
  the expiry filter — it is not itself added to `StateSnapshot`, so this
  doesn't make the timeline value AI-visible, only its derived effect
  (which debuffs remain active).
- **`scope/`** (`src/scope/index.ts`) — `getScope(world, state, characterId)`
  returns a character's current node (environmental codes now read
  directly from `state/`'s already-computed `CharacterState.environmentalCodes`
  rather than recomputing the merge, and connections with **computed**
  direction), their `effectiveStats` and current `inventory` (see `state/`
  above — this is how the AI actually sees debuff/equipment-adjusted
  stats and current item quantities/equipped state via `get_scope`,
  distinct from `get_character_sheet`'s static starting inventory), plus
  which other characters are co-located (`othersPresent`). Direction is an
  8-point compass computed from same-region local-position deltas, or
  region-position deltas when comparing nodes across regions (local
  sub-grids are unbounded and not comparable cross-region); two nodes at
  the same position on different layers resolve to `"up"`/`"down"`. An
  edge's authored `direction` override, when present, still wins over the
  computed value.
- **`tools/`** (`src/tools/index.ts`) — the beta check + action tool set:
  - `get_scope` (check) — wraps `scope/`'s `getScope`.
  - `get_character_sheet` (check) — looks up a loaded character's sheet.
  - `get_recent_dtm` (check) — wraps `dtm.recent`.
  - `say` — a character speaking (dialogue, taunts, questions). Always
    permitted: no `checkAction`/`rules/` gate, no escalation on repeat,
    since speech has no capability or legality dimension the way
    `move`/`use_technique`/`interact` do. Still a write — appends a
    `character.said` dtm event with `{message, targetId}` — so it persists
    in history, but it's neither a read-only check tool nor a validated
    `action`; a third category for world-changes the engine never needs to
    contest.
  - `note_hazard` — the same ungated category as `say`, for a one-off
    narrative note about a notable environmental detail or hazard that has
    no mechanical definition (see `applyEnvironmentalEffects`'s null
    fallback below). Appends a `hazard.noted` dtm event with
    `{description}`. "One-time" is enforced by prompt guidance to the
    model (use it once per notable hazard, not every turn), not hard
    engine-side dedup — this is flavor text with no mechanical stakes, so
    occasional redundancy isn't a correctness concern worth engineering
    around. Not for mechanically-resolved effects, which apply
    automatically with no tool call needed.
  - `action` (action) — a single tool with a discriminated-union payload
    (`{type: "move", ...}`, `{type: "use_technique", ...}`, or
    `{type: "interact", ...}`), rather than one tool per action type.
    Functions are exported per action type and dispatched by
    `checkAction`/`applyAction`. Zoning by **validation posture**, not by
    verb, is the engine's answer to "the closed `Action` union can't cover
    everything": `move` and `use_technique` are hard-gated because
    reachability and capability are deterministic facts, `interact` is the
    open-ended catch-all for anything else (attack, use item, investigate,
    manipulate the environment) — its content is free text, checked only
    for a coherent target, with the actual plausibility judgment pushed
    entirely to `rules/`. This means new "verbs" don't need new union
    members or new `checkAction`/`applyAction` code — only genuinely new
    *validation postures* (a new kind of hard gate) would.
    - `checkAction` — a deterministic, structural pre-check that runs
      **before** `rules/` is ever invoked, and can reject without any
      model call. For `move`, this is reachability (is the target node
      connected to the character's current node). For `use_technique`,
      this is the hard capability gate: the character's sheet must list
      the technique in its `techniques` array, or the action is rejected
      immediately with a reason (e.g. `"Son Goku" does not know a
      technique called "hakai"`) — an unknown technique never reaches
      `rules/` for a legality judgment, since knowing/not-knowing a
      technique isn't a judgment call. For `interact`, this is thinner but
      no longer single-gate: if a `targetId` is given, the target must
      exist and be co-located with the acting character (same node); and
      if an `itemId` is given, the character must actually carry that item
      with `quantity > 0` in `state/`'s current inventory (an item on the
      static sheet that's already been fully consumed no longer passes) —
      no capability check is possible for the free-form `description`
      itself, so these two structural checks are the only deterministic
      guardrails interact gets.
    - `applyAction(ctx, action, outcome)` — runs only after both
      `checkAction` and `rules/` approve, and appends the resulting dtm
      event (`entity.moved` for `move`, `technique.used` with a
      `{techniqueId, targetId}` payload for `use_technique`,
      `character.interacted` with a `{description, targetId}` payload for
      `interact`), tagged with `outcome` (`"valid"` or `"neutral"`, per
      `rules/`'s tri-state judgment below). `applyMove` additionally calls
      `applyEnvironmentalEffects` after the move's own dtm event: it
      resolves the target node's merged environmental codes (via
      `findNode`/`mergeEnvironmentalCodes` from `data/schemas/world.ts`),
      and for each `mechanical: true` code with an `effectId`, looks that
      id up in `ctx.loaded.ruleset.effects` — the same shared pool
      escalation draws from. A match applies exactly like an escalation
      debuff (identical `debuff.applied` event shape, so it's picked up by
      `state/`'s `activeDebuffs`/`effectiveStats` with no extra code,
      timeline-based duration reusing `escalation.debuffDurationUnits`
      since there's no separate environmental-duration config yet). No
      match is a **null fallback**: nothing mechanical happens — no
      engine-invented default effect gets substituted, since there's no
      universal "toxic" or "cold" effect the engine could sensibly guess
      at for content the Experience didn't define. This is deterministic;
      no model call is involved in whether an effect applies.
      `applyAction`'s `interact` case additionally calls `applyItemUse(ctx,
      characterId, itemId, turn)` whenever the action carries an `itemId`
      (skipped entirely for item-less interacts): for a `"consumable"`
      item this appends an `item.consumed` event (`{itemId, healAmount}`)
      — an instant, **permanent** effect via `state/`'s
      `totalHealingReceived`, not a timeline-expiring debuff, since healing
      isn't something that should wear off; for an `"equipment"` item it
      appends an `item.toggled` event flipping `equipped` (reading the
      current state first so it toggles rather than always equipping) — a
      **standing** modifier for as long as `equipped` stays true, not
      time-based at all, picked up by `computeEffectiveStats` alongside
      debuffs' `armorClassDelta`/`maxHitPointsDelta`. Both are deliberately
      separate mechanisms from the debuff/hazard timeline system rather
      than forced into `EffectDef`'s shape, since neither "permanent" nor
      "toggled by presence" fits an expiring-effect model.
    - `rejectAction(ctx, characterId, actionType, reason, turn)` — the
      escalation path, called whenever `checkAction` fails or `rules/`
      judges an action `"invalid"`. Reads its tuning from
      `ctx.loaded.escalation` (see Escalation Config above) rather than
      hardcoded constants. Appends an `action.rejected` dtm event (`turn`
      is only used for this event's own `timestamp` column — turn count,
      for ordering), then counts that character's total rejections; once
      the count reaches `escalation.strikeThreshold`, this and every
      further rejection also appends a `debuff.applied` event, with
      `appliedAtUnit` read from `ctx.timeline.currentUnit()` and
      `expiresAtUnit` set `escalation.debuffDurationUnits` timeline/ units
      later — real-wall-clock-anchored, so a debuff's real-world duration
      doesn't depend on how many turns the player takes in that span. The
      specific effect is drawn at random from `ctx.loaded.ruleset.effects`
      (the Experience's resolved effect pool — see Escalation Effects
      above), but only from
      effects whose `severity` is at or below an eligible ceiling that
      rises by 1 with each strike past the threshold (capped at
      `escalation.maxSeverity`): strike 3 can only draw severity 1 (with
      the defaults), strike 4 severity ≤2, and so on — `pickEffect` falls
      back to the pool's lowest-severity entries if none qualify (e.g. a
      custom pool with no severity-1 entries), so escalation never has
      zero eligible effects. This is deterministic bookkeeping, not a
      model judgment call — it fires the same way whether the rejection
      came from the hard capability gate or `rules/`'s situational
      judgment.
    Both `applyAction`/`rejectAction` return `{success: false, reason}`
    shapes rather than throwing on a rejected action.
- **`rules/`** (`src/rules/index.ts`) — `RuleValidator` implements the
  "separate validation prompt" approach: given an `LlmDriver` (not
  `node-llama-cpp` directly — see the pluggable Model backend note above),
  it opens its own `ChatDriverSession` (a dedicated `LlamaContextSequence`
  under the hood for the local backend, sharing the loaded model/context
  with the narrative session but not its chat history; an independent
  message array under the hood for the API backend), reset before every
  call so each validation is stateless. The model's response is forced
  into a tri-state `{outcome: "valid" | "neutral" | "invalid", reason:
  string}` via `ChatDriverSession.promptForJson` (GBNF grammar locally,
  `response_format: json_schema`/`json_object` over an API) — `"valid"`
  succeeds as attempted, `"neutral"` is a fizzle
  (attempted, but doesn't fully succeed given current state/conditions —
  not a rejection), `"invalid"` doesn't happen at all. The state passed to
  the model includes each character's `activeDebuffs` and current node's
  `environmentalCodes`, so the judgment can factor in prior escalation and
  environmental hazards (e.g. acting in a mechanically-toxic location
  might reasonably be judged `"neutral"` instead of `"valid"`). Called by
  `ai/`'s `action` handler only for actions that already passed `tools/`'s
  `checkAction`.
  Since `interact` has no hard gate beyond target presence, `rules/`'s
  system prompt is the only grounding its free-form content gets, so it's
  written to be explicit rather than relying on the model to infer intent:
  concrete per-outcome criteria tied to state fields (position,
  abilities/skills/techniques, active debuffs), an instruction to judge
  mechanical plausibility only — not tone or prose quality, that's the
  narrator's job — and three worked examples (one per outcome) to anchor
  a small local model's judgment. The prompt also names a trust boundary
  explicitly: an action's `description` can assert things not backed by
  state (a claimed capability, item, or prior event) — those claims trace
  back to player input, not engine fact, so the model is told to judge
  plausibility strictly against `state`, never against what the
  description itself asserts.
- **`audit/`** (`src/audit/index.ts`) — `NarrationAuditor` implements the
  same "separate validation prompt" pattern as `rules/`: given an
  `LlmDriver`, its own `ChatDriverSession`, history reset every call. Given
  a turn's narration text and the exact tool calls
  (with results) made that turn, it decides `{consistent: boolean,
  contradiction?: string}` — a grammar-forced fact-check of whether the
  narration accurately reflects what actually happened (success vs.
  failure, the real outcome, specific facts like which node a move
  landed at), explicitly not a writing-quality judgment. Kept isolated
  from the narrative session for the same reason `rules/` is: the
  reasoning that produced the narration shouldn't also be the reasoning
  that grades it. See `ai/` below for how its verdict drives
  retry-then-fallback.
- **`ai/`** (`src/ai/index.ts`) — `createAiSession(options)` takes a
  `BackendConfig` (`{type: "llamaCpp", modelPath}` or `{type: "api",
  baseURL, apiKey, model}`) and builds the matching `LlmDriver` — see the
  pluggable Model backend note above. For the local backend this opens one
  `LlamaContext` and draws three sequences from it; for the API backend
  each session is just an independent in-memory message array — either
  way, one `ChatDriverSession` backs the narrative loop, one backs
  `rules/`'s `RuleValidator`, one backs `audit/`'s `NarrationAuditor`
  (`RuleValidator`/`NarrationAuditor` each call `driver.createChatSession`
  themselves with their own fixed system prompt, so `ai/` never needs to
  know their prompts). Declares the three check tools, `say`,
  `note_hazard`, and the unified `action` tool as a `ToolDef[]` array
  (`{name, description, parameters, handler}` — the `action` tool's
  `parameters` use a JSON Schema `oneOf`/`const` shape to express the
  `move`/`use_technique`/`interact` discriminated union; the local backend
  compiles this into a GBNF grammar via `defineChatSessionFunction`, the
  API backend passes it straight through as an OpenAI-style tool schema)
  and drives the agentic loop through `session.prompt(input, tools)` (see
  the Turn Flow beta deviation above re: the uncapped loop — bounded for
  the API backend only, at `apiDriver.ts`'s `maxToolRounds`, since that
  loop is now reimplemented by hand rather than owned internally by
  `node-llama-cpp`). The `action` handler funnels every call
  through `checkAction` → `rules/`'s `RuleValidator.validate` →
  `applyAction`/`rejectAction`, short-circuiting to `rejectAction` on the
  first rejection from either stage. Each tool handler is wrapped by a
  `record()` helper that invokes an optional `onToolCall?: (call) => void`
  callback — this is how `io/`'s debug-dump mode observes tool calls
  without `ai/` depending on `io/` — and also pushes into an internal
  `turnToolCalls` array reset at the start of each `prompt()` call, used by
  the narration-consistency step below.
  After `session.prompt()` returns a turn's narration, if that turn
  included an `action` call, `prompt()` runs `audit/`'s `NarrationAuditor`
  against the narration and `turnToolCalls`. On `{consistent: false}`, it
  reprompts the *same* narrative session with the contradiction named,
  deliberately **without** `tools` — so the retry can only regenerate
  text, never re-trigger tool calls and re-apply state a second time — up
  to `MAX_NARRATION_RETRIES` (2) times. If still inconsistent, it falls
  back to `buildFallbackNarration`: a deterministic, model-free sentence
  built directly from the `action` call's own params/result (e.g. `"goku
  moves to \"drifting-wreckage\"."`, or the rejection's `reason` verbatim
  on failure) — a hard guarantee the player is never shown narration
  *confirmed* to contradict what actually happened, at the cost of losing
  narrative flourish for that turn. Every turn (checked or not) appends a
  `turn.audited` dtm event — `{narration, toolCalls, checked, consistent,
  retries, usedFallback}` — persisting the full narration text, since a
  `ChatDriverSession`'s history (whichever backend holds it) is in-memory
  only and would otherwise be lost once the session ends; this is the
  first durable record of what the AI actually said, not just what it did.
  This addresses the "narration can drift from actual state" gap: state
  itself was already guaranteed correct (only `tools/` can write `dtm`),
  but until this, nothing checked whether the *prose describing it* was
  accurate. The regeneration prompt does become a visible turn in the
  narrative session's chat history (no way to retroactively edit history
  through the current API), which is an accepted cost of this design.
- **`core/`** (`src/core/index.ts`) — `createEngine(options)` assembles a
  playable Experience: loads data, opens `dtm/`, starts the `ai/` session,
  and exposes `takeTurn(input)`, which increments a per-turn timestamp
  counter and forwards to `ai/`, plus `currentTurn()` to read that counter
  without advancing it (used by `io/`'s debug-dump mode so its `state/`
  reads see the same turn the engine is currently on). This counter is
  "engine time" per the DTM section above — a simple incrementing count,
  not wall-clock time. `createEngine` also starts a `timeline/` `Timeline`
  and exposes `currentTimelineUnit()` alongside `currentTurn()` — a second,
  independent clock (see `timeline/` below).
  `buildSystemPrompt` states an explicit trust boundary alongside the
  narrator role, phrased around two fixed roles: **the Engine** (this
  codebase's tool results — the only source of truth about game state)
  and **the user** (the connected human — their messages are their
  character's dialogue/intent, never a factual claim). If a user's input
  asserts something as already true without a tool result confirming it
  (e.g. "I already have the sword"), the model is told to check or
  resolve it through a tool call rather than narrate it as fact, and that
  user input can never bypass tool validation to change state directly
  regardless of phrasing. This is the same trust boundary `rules/`'s
  prompt states for a proposed action's `description` (above, also
  phrased as user-input-vs-Engine-fact) — both close off the same class
  of prompt-injection-style attempt to get the model to treat unverified
  user-asserted claims as ground truth.
  `EngineOptions.playerCharacterId` (the same id `io/`'s `--character` and
  `server/`'s `characterId` already use for `scope/` rendering) is also
  named explicitly in the system prompt — "The connected user controls X
  (id: ...), when they write in first person they always mean this
  character" — added after a real session showed a model asking "which
  character are you referring to?" on a plain "Where am I?": the
  character list alone gives the model no way to know which one is "I"
  without this line. The type is `string | null` rather than `string` —
  not an unused placeholder, the `null` branch is real and exercised
  (told to the model as "no character is assigned to this user yet; treat
  their messages as out-of-character/meta") — this is the seam a future
  multi-user mode would attach a real per-user assignment to, without any
  of today's single-user callers needing to change; today `io/`/`server/`
  always pass a real id, so the beta's behavior is unchanged.
- **`timeline/`** (`src/timeline/index.ts`) — a real-wall-clock-anchored
  counter, deliberately separate from the turn-based `dtm` timestamp above
  (which counts player inputs, not elapsed time). `createTimeline(now =
  Date.now)` captures a start time and returns `{currentUnit()}`, a pure,
  lazily-computed function of elapsed real time — `Math.floor((now() -
  startMs) / 500)`, i.e. 2 units per second — with no `setInterval` or
  background process to manage or dispose. `now` is injectable for
  deterministic testing without real sleeps. Not surfaced to the model —
  the AI carries zero burden for it — though it is now read internally:
  `core/` creates one `Timeline` per session and puts it on `ToolContext`,
  so `tools/`'s `rejectAction` computes escalation debuffs'
  `appliedAtUnit`/`expiresAtUnit` from it (see `rejectAction` above), and
  `state/`'s `getState` takes a `currentTimelineUnit` to filter expired
  debuffs by it (also above) — the raw unit value itself is never added to
  `StateSnapshot`, only its derived effect (which debuffs remain active).
  In-memory per session, not persisted across restarts, same as `core/`'s
  turn counter. The planned environmental `effectId` resolution (Beta
  Preparation below) is expected to reuse this same duration model once
  built.
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
- **`server/`** (`src/server/index.ts`, `src/server/cli.ts`,
  `src/server/modelCatalogue.ts`) — an HTTP bridge for `frontend/`'s web
  UI, since `core/`'s `Engine` was previously only ever driven directly
  from `io/`'s stdin loop. Beta scope is explicitly **single-session**:
  one Engine, one player-controlled `characterId`, no accounts or
  concurrent-session routing. Unlike `io/`, the server does **not** build
  its `Engine` at startup — backend/model choice is a runtime, frontend-driven
  decision (the model picker described below), not a fixed deploy-time
  environment variable, since the target user is on a phone with no local
  dev environment and needs to pick/swap models from the browser. The
  server boots holding `engine: Engine | null` and a `BackendStatus`
  (`idle | downloading | starting | ready | error`); `POST /api/backend`
  is what transitions it. A plain `node:http` server (no framework
  dependency) exposes:
  - `GET /api/health` — `{status, experience}`, unauthenticated (so the
    frontend's initial connectivity check and any uptime probe don't need
    the key). The experience name is read once via a standalone
    `loadExperience` call at startup — independent of the (lazy) Engine —
    so this works even before a model is chosen.
  - `GET /api/backend/status` — the current `BackendStatus`, polled by the
    frontend (every 3s) to drive its model-status indicator and to unlock
    the composer the moment a swap finishes.
  - `GET /api/models/search?q=` / `GET /api/models/:repoId/files` — proxy
    `modelCatalogue.ts`'s `searchGgufModels`/`listGgufFiles` (both call
    Hugging Face Hub's public models API directly, no auth needed) so the
    frontend can browse the live GGUF catalogue without embedding any Hub
    credential client-side.
  - `GET /api/backend/providers` — which API providers (see
    `apiProviders.ts` below) are actually configured on this server, as
    `{id, label}[]` — never the base URL or key. Drives the frontend's
    provider `<select>`, and lets it show "no providers configured" if
    the list comes back empty.
  - `GET /api/models/api/:provider` — proxies `apiModelCatalogue.ts`'s
    `listApiModels`, `400`s if the provider isn't known/configured (same
    check as `POST /api/backend`). Returns `{id, label}[]` of that
    provider's free, tool-calling-capable models, or `[]` if the provider
    has no public catalogue to query — the frontend falls back to manual
    model-id entry in that case.
  - `POST /api/backend` — `{type: "llamaCpp", repoId, filename}` or
    `{type: "api", provider, model}`. Rejects with `409` if a switch is
    already `downloading`/`starting` — a real HF Space session showed two
    overlapping requests (from a frontend double-tap) racing to write the
    same `modelsDir` path, corrupting the GGUF (a tensor ending up
    truncated mid-file); this guard, plus a matching client-side
    in-flight guard in `frontend/app.js`, closes that. For `llamaCpp`,
    kicks off `modelCatalogue.ts`'s `downloadGgufModel` (capped at
    `MAX_MODEL_BYTES` = 6GB via a HEAD request's `Content-Length`;
    deletes any previously-cached `.gguf` in `modelsDir` first — only one
    local model is kept on disk at a time) then swaps the `Engine` onto
    the new `LlamaCppBackendConfig`. For `api`, looks `provider` up in
    `options.apiProviders` (rejecting with `400` if that provider isn't a
    known id or has no key configured) and swaps onto its
    `baseURL`/`apiKey` plus the frontend-supplied `model` string only —
    **the real credential is a server-side-only secret, and is never
    accepted from or echoed back to a request; the frontend can only ever
    choose which provider and model id to use.** Responds `202`
    immediately (a download/model-load can take minutes) — the frontend
    polls `/api/backend/status` rather than blocking on this call.
    `/api/scope` and `/api/turn` are gated on `status.status === "ready"`,
    returning `409` otherwise so the frontend knows to prompt for a model
    instead of treating it as a hard connection error.
  - `POST /api/backend/unload` — disposes the current `Engine` (freeing
    the loaded model's RAM) and returns `status` to `idle`, without
    touching `modelsDir` — a previously-downloaded GGUF stays cached on
    disk so reloading the same model later skips the download. Also
    `409`s if a switch is mid-flight, for the same reason as above.
  All routes set CORS headers for a single configured `corsOrigin` (the
  GitHub Pages origin), and everything but `/api/health` is gated behind
  an `X-Api-Key` header checked against a `SERVER_API_KEY` — this is a
  public endpoint sitting in front of a real, cost-incurring model call
  (and, for `llamaCpp`, a multi-GB download trigger), so even
  single-session beta ships with a shared-secret gate rather than none;
  `server/cli.ts` prints a startup warning if it's left unset. `cli.ts`
  reads its entire configuration from environment variables (not CLI
  flags, since it's meant to run unattended in a container — see
  `deploy/hf-space-server/`). `BACKEND` / `MODEL_PATH` / `API_MODEL` env
  vars from the pre-runtime-picker design are gone — model choice no
  longer belongs at deploy time.
- **`server/apiProviders.ts`** — a small hardcoded registry of known
  OpenAI-compatible API providers (`apiDriver.ts` is generic enough to
  talk to any of them with no provider-specific code): currently
  `huggingface` (`https://router.huggingface.co/v1`) and `openrouter`
  (`https://openrouter.ai/api/v1`), each with a public base URL baked in
  plus one API-key env var (`HF_API_KEY`, `OPENROUTER_API_KEY`). `cli.ts`
  builds `ServerOptions.apiProviders` by checking each provider's env var
  independently — a provider with no key set is simply absent from the
  map and won't appear in the frontend's picker. Adding a new provider
  later is one entry in this file plus a new secret, no frontend changes
  needed (it's discovered automatically via `GET /api/backend/providers`).
- **`server/apiModelCatalogue.ts`** — per-provider free-model listers,
  keyed the same way `apiProviders.ts` is. Currently only
  `openrouter` has one (`listFreeOpenRouterModels`, hitting OpenRouter's
  public, unauthenticated `GET /api/v1/models` and filtering to
  `pricing.prompt === "0" && pricing.completion === "0"` plus
  `supported_parameters` including `"tools"` — a model this engine can't
  drive tool calls with can't run a turn regardless of price). A provider
  with no lister here just returns `[]`, which the frontend takes as "no
  catalogue, fall back to manual entry" rather than an error. Added after
  a real user typed a bare word ("Llama") into the old free-text-only
  model-id field and got a `400` from OpenRouter — a raw text field for a
  provider's exact model slug isn't a workable UI on its own.
- **`frontend/`** — the static web UI that drives `server/`'s API from a
  browser. See `docs/FRONTEND_ARCHITECTURE.md` for its design.

### Context Efficiency

Measured directly against the real fixture: a single user turn that
resolves an `action` costs 4 sequential API calls (narrative tool-call
round, `rules/`'s validator, narrative final round, `audit/`'s narration
check) and ~5,150 tokens at turn 1 — growing ~270-300 tokens every
subsequent turn, since the narrative session's chat history was never
trimmed. Three targeted fixes, all measured against the real fixture
rather than assumed:

- **Scoped rules-validator state** (`ai/index.ts`'s `scopeStateToAction`) —
  `rules/`'s `validate()` used to receive the *entire* `StateSnapshot`
  (every character in the Experience) even though its judgment only ever
  depends on the acting character and its target, if any. Now only those
  are included. No effect in the 2-character `goku-vs-venom` fixture
  (actor + target already covers the whole cast), but verified against a
  synthetic 5-character snapshot: a 57% reduction, and the saving scales
  with cast size, not just this fixture.
- **Compacted stale tool-call results** — the largest per-turn growth
  driver was tool-call *results* (especially `get_scope`'s full JSON blob)
  getting permanently baked into the narrative session's history the
  moment they're returned, even after they're superseded by a newer call
  describing current state. This is one part of the single unified
  `compactContext` pipeline described below, not a separate mechanism —
  see there for the full design. Verified live: a ~1KB `get_scope` result
  from turn 1 shrinks to 52 bytes by the time turn 2's request is built.
- **Skip the narration audit on clean outcomes** (`ai/index.ts`'s
  `needsFullAudit`) — the separate LLM call to `audit/`'s
  `NarrationAuditor` now only runs when at least one of the turn's
  `action` calls was rejected or resolved `"neutral"` (didn't fully land)
  — the cases where a model is actually tempted to narrate the success it
  wanted rather than what happened. A turn where every action was a clean,
  fully-successful outcome skips this call entirely, cutting one of the 4
  calls (and its ~450 tokens) for the common case. The cheap, local
  blank/leaked-tool-call-syntax check (`isInvalidNarration`) still always
  runs regardless — only the costlier full consistency audit is
  conditional. `dtm/`'s `turn.audited` event's `checked` field now
  accurately reflects whether the full audit actually ran, not just
  whether an action was attempted.

**One unified `compactContext` pipeline, not two separate mechanisms.**
Per-turn tool-result compaction and multi-turn summarization were
initially built as two independent things — an always-on step hidden
inside `apiDriver.ts`'s `prompt()`, and a separately-triggered step in
`ai/index.ts` — which overlapped wastefully (a rollup turn would discard
history the other mechanism had just carefully compacted) and split "what
gets shrunk and when" across two files with two different triggers. Both
are now one method, `ChatDriverSession.compactContext(summary?: string)`
(`llmDriver.ts`), called exactly once per turn from `ai/index.ts`'s turn
loop and nowhere else — no automatic/hidden compaction happens inside
`prompt()` itself:
- Called with no argument (an ordinary turn): compacts that turn's own
  tool-call results to a short fixed placeholder now that they've served
  their purpose (fed the model's own next reply) — keeping the full JSON
  blob around forever only grows every later request for no ongoing
  benefit.
- Called with `summary` (a rollup turn — see the summarization design
  below): replaces the *entire* history (since the system prompt) with one
  message containing it, superseding the plain per-turn compaction for
  that call, since a recap already accounts for everything it replaces.

**Two-level turn-history summarization** (`src/summarizer/index.ts`'s
`Summarizer`, wired into `ai/index.ts`'s turn loop) is what decides when
`compactContext` gets a `summary` — the fix that actually *caps*
narrative-session context growth long-term, rather than just reducing its
slope like the three fixes above. Runs in its own isolated chat session,
the same pattern as `rules/`'s `RuleValidator` and `audit/`'s
`NarrationAuditor`:
- Every `SUBBLOCK_TURN_COUNT` turns (5), the span's raw narrations are
  compressed into one ~`SUBBLOCK_TARGET_WORDS`-word (50) "subblock"
  summary, preserving concrete facts (who did what, outcomes, injuries,
  location changes) and dropping flavor prose.
- Every `SUBBLOCKS_PER_BLOCK` subblocks (10 — i.e. every 50 turns), those
  subblock summaries are compressed again into one coarser
  ~`BLOCK_TARGET_WORDS`-word (75) "block" summary, and the subblock list
  resets — so growth is logarithmic-ish over a long session rather than
  accumulating one 50-word subblock every 5 turns forever.
- The resulting recap (`[...blockSummaries, ...subblockSummaries].join(" ")`)
  is what `compactContext` receives on a rollup turn. `dtm/` still holds
  the complete raw history regardless — only what's sent to the model
  going forward is reduced.
- **Implemented for both backends.** `apiDriver.ts`'s `ApiChatSession`
  mutates its flat message array directly. `llamaCppDriver.ts`'s
  `LlamaCppChatSession` uses `LlamaChatSession`'s real
  `getChatHistory()`/`setChatHistory()` API — initially assumed not to
  exist (an earlier version of this doc said local sessions couldn't
  support this), but node-llama-cpp does expose it. Its representation
  differs from the API driver's flat array: tool-call results live as
  `result` fields on `ChatModelFunctionCall` segments nested inside each
  `ChatModelResponse`, not as separate top-level messages — but `result`
  is a plain, freely-rewritable field, so the same placeholder-compaction
  and full-history-replace logic both apply, just walking a nested
  structure instead of a flat one. `compactContext` stays optional on the
  `ChatDriverSession` interface for any future driver that genuinely can't
  support it, called via `session.compactContext?.(...)`, but both
  current backends implement it fully. `llamaCppDriver.ts`'s
  pre-allocated sequence count (3 → 4, for the new summarizer session)
  now actually pays off on that backend too, not just the API one.

Verified against the real fixture with a mocked backend across 56
simulated turns: the first subblock summary is generated at turn 5 and
folded into the recap by turn 10; the 10th subblock triggers a block-level
rollup at turn 50, resetting the subblock list; and the recap sent on
turn 56's request correctly shows the block summary plus only the
newest (11th) subblock, not the pre-rollup subblocks it replaced.
Re-verified after unifying into `compactContext`: turns 1-4 within a
window still get their own tool results compacted turn-by-turn, and
turn 5's rollup still fully replaces history (turn 6's request shows just
3 messages: system, recap, new input) — confirming the merge changed only
where the logic lives, not its observed behavior. `llamaCppDriver.ts`'s
implementation was verified separately as a standalone data-transformation
test against realistic `ChatHistoryItem` shapes (a real GGUF model can't
be loaded in this environment): confirmed a `ChatModelFunctionCall`
segment's `result` field is correctly replaced with the placeholder on an
ordinary turn, and that a rollup call correctly collapses history down to
exactly `[systemMessage, recap]`. `npm run typecheck` passes.

### Test Experience: Goku vs Venom — Null Void Showdown

`examples/goku-vs-venom/` is the smoke-test fixture for the beta slice: Goku
and Venom (D&D-range stats, 10–20) placed in Ben 10's Null Void dimension —
one `open`-type region (`null-void-expanse`) with three connected nodes
(`battlefield-core`, `drifting-wreckage`, `suspended-shard`), the last
carrying a genuine `mechanical` environmental code (`gravity`/`unstable`,
`effectId: "disoriented"`) so the hazard-resolution path is exercised by the
checked-in fixture itself rather than only ad hoc test data. The Experience
declares no custom abilities/skills, but does declare a custom `effects`
entry (`disoriented`, backing the new node's hazard) and two custom `items`
(`senzu-bean`, a consumable; `salvaged-plating`, equipment) additively
alongside `DEFAULT_EFFECTS`/`DEFAULT_ITEMS`, exercising both the
default-ruleset fallback path and `resolveEffectDefs`/`resolveItemDefs`'s
per-entry-fallback merge in the same fixture. Each character's sheet also
declares three `techniques` (Goku: `kamehameha`, `instant-transmission`,
`kaio-ken`; Venom: `symbiote-tendrils`, `venom-bite`,
`symbiote-camouflage`) to exercise the `use_technique` capability gate.
Verified via ad hoc scripts (not a
checked-in test suite yet) that `loadExperience`, `getState`, `getScope`, and
`tools/`'s `checkAction`/`applyAction` interoperate correctly: starting
positions resolve from the Experience's declared placements, scope reports
correct connections/direction/`othersPresent`, a valid move updates `dtm/`
and is reflected in the next `getState`/`getScope` call, an invalid move
target fails gracefully instead of throwing, a technique the character's
sheet lists succeeds, and a technique not on the sheet (e.g. Goku attempting
`hakai`) is rejected by the capability gate before any model call. Also
verified the escalation path directly against `tools/`'s `rejectAction`:
repeating a rejected `hakai` attempt across turns produces narrative-only
rejections on strikes 1–2, a severity-1-only `debuff.applied` event on
strike 3, a severity-≤2-eligible one on strike 4 (and so on, stacking),
and `getState`'s `activeDebuffs` correctly drops each debuff once its
`expiresAtUnit` has passed (verified against an injected fake clock, not
real sleeps — see `timeline/`'s injectable `now` below). Also verified
`resolveEffectDefs`'s per-entry
fallback: a custom Experience-declared effect list can override a default
id (e.g. redefine `exposed`), add new higher-severity effects, and still
falls back to any default id it didn't touch (e.g. `weakened`,
`battered`). Also verified `resolveEscalationConfig`'s per-field fallback:
an Experience declaring only `strikeThreshold: 1` escalates on the very
first rejection while `maxSeverity`/`debuffDurationUnits` still resolve
from `DEFAULT_ESCALATION_CONFIG`. Also verified, with an injected fake
clock via `timeline/`'s `createTimeline(now)`, that a debuff's real-world
duration is entirely decoupled from turn count: 3 strikes taken instantly
(no elapsed real time between them) still produced a debuff that stayed
active right up to `debuffDurationUnits - 1` and expired exactly at
`debuffDurationUnits`. Also verified `state/`'s
`computeEffectiveStats`: two stacked `armorClassDelta` debuffs reduce
Goku's effective armor class accordingly while his base sheet is
untouched, `scope/`'s `effectiveStats` matches `state/`'s exactly, a
character with no active debuffs shows effective stats identical to its
base sheet, and a sheet declaring neither `armorClass` nor `hitPoints`
resolves to an empty `effectiveStats` rather than throwing. Also verified
`applyEnvironmentalEffects` against `suspended-shard`'s checked-in
`mechanical` environmental code (`gravity`/`unstable` → `effectId:
"disoriented"`, part of the fixture itself): arriving there applied a
real debuff (confirmed via the resulting `effectiveStats` change), and
separately against an injected node with an unmatched `effectId` to
confirm the null-fallback path (no mechanical effect, `note_hazard` logs
a `hazard.noted` event instead). Also verified the item/inventory
system: each character's sheet declares a starting `inventory` (Goku:
two `health-potion` plus one `senzu-bean`; Venom: one `iron-shield` and
one `salvaged-plating`, both unequipped) resolved against
`DEFAULT_ITEMS` via `resolveItemDefs`'s per-entry fallback (same pattern as
effects/abilities/skills). Confirmed `checkInteract`'s item gate rejects an
`itemId` the character doesn't carry (and rejects it again once a
consumable's `quantity` hits 0 from prior uses) before any model call.
Confirmed `applyItemUse`'s two behaviors end-to-end through `state/`'s
`currentInventory`/`totalHealingReceived`: consuming a `health-potion`
appends `item.consumed`, decrements quantity by one, and raises the
character's effective `hitPoints.current` (verified with Goku's HP set to
100/180 to avoid the max-HP clamp masking the math — two consecutive
potions produced 100→120→140, and a third attempt after quantity reached 0
was correctly rejected by the gate; a subsequent overheal case confirmed
140+100 clamps to the sheet's `max: 180` rather than overshooting); toggling
`iron-shield` appends `item.toggled` and immediately changes
`effectiveStats.armorClass` by the item's `armorClassDelta` while equipped,
reverting when toggled back off, with the base sheet's `armorClass`
untouched throughout — mirroring how debuffs affect `effectiveStats` without
touching the sheet. Also verified `ai/`'s `buildFallbackNarration`
directly against real `applyAction`/`rejectAction` results for every
action type and outcome (valid move, neutral technique, valid interact,
a capability-gate rejection), confirming each produces an accurate,
tool-result-only sentence, and confirmed the `turn.audited` dtm event
persists the full expected shape. `audit/`'s `NarrationAuditor` itself —
like `rules/`'s `RuleValidator` — has not been exercised against a real
loaded model in this environment; only the deterministic code around it
(what triggers the check, what happens on failure) is verified.

---

## Effects & Mechanical Grounding

An effect is a **modifier to a variable on whatever it's linked to** —
a character's stats, a location's conditions, a whole region or world's
rules, or the Experience's ruleset itself. Today only the character-linked
case is built (debuffs, item deltas, and — as of this section — technique
damage); location/world/experience-linked effects beyond the existing
per-node/region `EnvironmentalCode` are still design, not code. This
section records the full concept, then says explicitly what's actually
built (Phase 1) versus deferred.

### The concept

**Scope hierarchy.** A character is placed at a node; nodes belong to a
region; regions belong to a world; a world is used by an Experience. Effects
can in principle attach at any of these levels — a personal buff on a
character, a standing hazard on a location (already built, see
Environmental Hazards below), a region/world-wide condition, or an
Experience-wide rule that applies everywhere regardless of location. What's
undesigned: the precedence/merge rule across all four levels at once (today
only node-overrides-region exists, via `mergeEnvironmentalCodes`).

**Effect type taxonomy.** Four kinds, distinguished by how long they last
and whether they're triggered or continuously true:
- **Temporary** — expires after a duration. Already built: `AppliedDebuff`,
  timeline-unit-based (see Escalation Effects above and Environmental
  Hazards below).
- **Permanent** — applied once, never expires, accumulates forever. Already
  built as of Phase 1 below (`currentHitPointsDelta`), and previously
  existed in a narrower, hardcoded form as item healing.
- **Static** — an unconditional, always-on trait baked into a definition,
  no trigger needed. Partially built: equipped items' deltas work exactly
  this way already (see Item Catalog & Inventory above), just not
  generalized as a named "static effect" concept beyond items.
- **Dynamic** — active only while some condition holds, recomputed fresh
  every state read rather than triggered-once-and-decaying (e.g. a
  modifier that applies only while standing at a specific node). **Not
  built** — today's environmental hazards are actually *temporary*,
  triggered once on arrival, not continuously re-evaluated against current
  position.

**AI-authored mechanics (the "write tool" question).** Everything built so
far rests on one invariant: the AI proposes, but all mechanical numbers
come from pre-authored data the engine validates against — the AI never
invents a new rule live (see the Engine-vs-User Trust Boundary discussion
in Beta Implementation above). Letting the AI define a *new* effect at
runtime — for situations no author anticipated — breaks that invariant on
purpose, so it needs its own guardrails, sketched as a graded authority
ladder rather than an all-or-nothing switch:

| Tier | Capability |
|---|---|
| 0 | Select an existing pre-authored effect (already built: escalation's pool, `note_hazard` for flavor-only notes) |
| 1 | Tune a number within a bounded range on an existing effect template |
| 2 | Define a brand-new `EffectDef` from scratch, still schema-validated and severity-capped |
| 3 | Attach a newly-authored (or existing) effect to a location via a new `EnvironmentalCode` |
| 4 | Generate a whole new `Node` (id, description, connections, hazards) |

Key resolved design questions for whenever this is built:
- **Magnitude is never AI-authored, even at tier 2+.** The AI proposes a
  category (a severity tier 1-5, which stat it targets) — the same kind of
  categorical judgment `rules/`'s tri-state validator already makes — and
  the engine converts severity to an actual delta via a fixed formula it
  owns (e.g. `armorClassDelta = -severity`). This is exactly how
  escalation already separates "AI/validator judges category" from
  "engine computes the number" (see Escalation Effects above); authoring
  extends the same split rather than introducing a new one.
- **Same validation path, no exceptions.** Whatever the AI authors, at any
  tier, parses through the exact same Zod schemas Experience-authored JSON
  already goes through — never a separate, looser path.
- **Runtime-logged, not written back.** An AI-authored effect/node lives in
  `dtm/`'s event log (permanent, replayable, part of that session's
  history), never mutates the Experience's source JSON on disk — writing
  back would blur "authored content" with "session history" and break if
  two playthroughs of the same Experience diverge.
- **Garbled/spam user input is not a special case.** The existing trust
  boundary already covers it: user input is never a factual claim and
  can't bypass validation, so nonsense input should simply fail to trigger
  the authoring tool at all, the same way it fails to trigger any other
  tool today. Schema validation and severity ceilings bound the blast
  radius even if the AI misfires on bad input.

None of tiers 1-4 are built. This is recorded here so the eventual
implementation has the resolved design questions on hand rather than
re-litigating them.

### Phase 1 (built): the damage primitive

The concrete gap that motivated this whole section: before this, a
technique landing on a target (e.g. Venom's bite, Goku's Kamehameha) did
**nothing** mechanically — `applyUseTechnique` only ever logged a
`technique.used` dtm event. The narration could claim damage happened; the
target's `effectiveStats.hitPoints` never actually changed, because no
delta field existed for "reduce current HP directly" — only
`maxHitPointsDelta` (shrinks the ceiling) and item-consumption healing
existed, and neither is "damage."

**What changed:**
- `EffectDefSchema` gained `currentHitPointsDelta?: number` alongside the
  existing `armorClassDelta`/`maxHitPointsDelta` — negative for damage,
  positive for a direct heal-like effect. This is a *permanent* effect
  field, not a *temporary* one like the other two: a hit doesn't heal
  itself back once some other debuff it also caused expires, so it can't
  go through `AppliedDebuff`'s timeline-expiry mechanism.
- `TechniqueDefSchema` gained an optional `effectId?: string`, the same
  pattern `EnvironmentalCode.effectId` already uses — a technique's
  pre-authored mechanical consequence on its target.
- `tools/`'s new `applyEffect` helper fans an `EffectDef` out to whichever
  mechanism matches each declared field's semantics: `armorClassDelta`/
  `maxHitPointsDelta` still go through the existing `debuff.applied`
  event (ongoing, timeline-expiring); `currentHitPointsDelta` goes through
  a new `effect.applied` event (permanent, no expiry). A single `EffectDef`
  can declare both at once (e.g. immediate damage plus a lingering guard
  opening) — each part only applies if the effect actually declares it.
  `applyEnvironmentalEffects` (hazards) was refactored to call the same
  helper, so hazards and landed techniques now share one mechanism instead
  of hazards having their own copy of the debuff-applying logic.
- `applyUseTechnique` resolves the acting character's technique's
  `effectId` against `loaded.ruleset.effects` and applies it to
  `action.targetId` — but only when the outcome is `"valid"` (a full
  success) and a target was actually named. A `"neutral"` outcome (attempted
  but didn't fully land) or a technique with no `effectId` still has no
  mechanical consequence — narration-only, same as before this existed.
- `state/`'s current-HP accumulator generalized from `totalHealingReceived`
  (item consumption only) to also sum `totalEffectHitPointsDelta`
  (`effect.applied` events) — heal and damage are now the same underlying
  mechanism (a signed, permanent, accumulating current-HP contribution),
  not two unrelated code paths. `computeEffectiveStats` now floors current
  HP at 0, not just clamps it to the effective max — a floor that only
  matters now that a negative contribution (damage) can push it down.
- `examples/goku-vs-venom` demonstrates it: Goku's `kamehameha` deals 15
  damage (`kamehameha-blast`, severity 4) and Venom's `venom-bite` deals 8
  (`bite-wound`, severity 2).

Verified directly against the real fixture: a valid Kamehameha reduces
Venom's `effectiveStats.hitPoints.current` from 160 to 145; a valid
Venom Bite reduces Goku's from 180 to 172; a `"neutral"` outcome leaves HP
unchanged; and repeated hits floor current HP at 0 rather than going
negative. `npm run typecheck` passes.

**What Phase 1 deliberately doesn't do:** no AI-authored effects (that's
tiers 1+ above), no `interact`-triggered damage for freeform attacks with
no pre-declared technique, and reduced/partial damage on a `"neutral"`
outcome (an attempt that "doesn't fully land" currently deals either full
declared damage or none, not a partial amount).

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
  identification via a CLI arg / `server/` config instead, see Beta
  Implementation above. `EngineOptions.playerCharacterId` being `string |
  null` (rather than a bare `string`) is deliberate groundwork for this:
  a future multi-user mode would route several connected users, each
  independently tied to a characterId or `null` (unassigned — e.g. a
  spectator, or someone who hasn't picked a character yet), through that
  same null-aware system-prompt branch. What's still undesigned and NOT
  built: actual multi-user session routing itself — concurrent per-user
  turns against one `Engine`/`Dtm`, whether that's one `Engine` handling
  several users or several `Engine`s sharing a `Dtm`, and how per-user
  identity is authenticated/assigned in the first place. Today's beta is
  still exactly one connected user per `Engine` process.
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
