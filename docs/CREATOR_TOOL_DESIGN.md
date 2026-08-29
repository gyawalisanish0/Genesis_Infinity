# Creator Tool — Design

> **Status:** proposal. Nothing here is built yet. Open decisions are collected
> in [§9](#9-open-decisions); the rest is a starting point to adapt, not a
> commitment.

---

## 1. Purpose

A graphical tool for authoring Experience packages — worlds, casts, and rules —
without opening a text editor.

**Who it's for:** a writer or game designer with a world in their head. They may
never have written JSON and shouldn't have to. The package format is a *save
format*, not an interface.

**What it produces:** exactly the package the engine already loads — one
`experience.json`, one `world.json`, and a `characters/*.json` per character
(see [EXPERIENCE_SCHEMA.md](EXPERIENCE_SCHEMA.md)). No new format, no
creator-only sidecar. A package built by hand and a package built in the GUI
are indistinguishable.

**What it is not:** a prose editor, an image generator, or a place to write the
story. The author builds the *world and its rules*; the engine plays it.

---

## 2. Principles

1. **The author is a writer, not a developer.** Never show a field name, an id,
   or a validation error phrased as a schema path.
2. **Progressive disclosure.** Every mechanical field is optional (as of the
   "everything optional" change), so the tool can start at zero numbers and
   reveal depth only when asked. Complexity is opt-in, and the schema already
   supports that shape — see [§3](#3-author-tiers).
3. **Nothing un-testable.** Any change an author makes must be playable
   immediately, and mechanically verifiable without spending a token
   ([§5.5](#55-playtest)).
4. **One source of truth.** The GUI edits the package; it does not maintain a
   parallel model that has to be synced. Round-tripping a hand-written package
   through the editor must not lose or reorder anything meaningful.
5. **The mechanics are the product.** Where a competitor's creator centers on a
   character persona, this one centers on a world with enforceable rules. The
   UI should make the rules visible, not hide them.

---

## 3. Author tiers

The tiers are a UI concept, not a schema concept — they map onto how much of the
(entirely optional) machinery the author has switched on.

| Tier | Author is thinking about | Fields touched | Result |
|---|---|---|---|
| **1 — Writer** | Places, people, voice | `name`, `description`, `personality`, `tone`, nodes + connections | A valid, playable, statless package |
| **2 — Game** | Capability and stakes | `abilities`, `skills`, `hitPoints`, `armorClass`, `techniques`, `inventory` | Characters who are mechanically distinct |
| **3 — Systems** | Consequence and tuning | `effects`, `items`, `environmentalCodes`, `difficulty`, `escalation`, `plotPoints` | A tuned ruleset with hazards and escalation |

Tier 1 must be genuinely complete on its own — a romance or interrogation piece
should never be forced to invent hit points. The tier selector should be a
single visible control ("Simple / Detailed / Full"), not buried in settings,
and switching up must never destroy data authored at a higher tier.

---

## 4. Surfaces

```
┌───────────────────────────────────────────────────────────┐
│  Library      →  pick or create a package                 │
├───────────────────────────────────────────────────────────┤
│  ┌─────────────┬───────────────────────────────────────┐  │
│  │  Sidebar    │   Editor pane                         │  │
│  │             │                                       │  │
│  │  · World    │   (map canvas / wizard / systems)     │  │
│  │  · Cast     │                                       │  │
│  │  · Systems  │                                       │  │
│  │  · Playtest │                                       │  │
│  │  · Publish  │                                       │  │
│  └─────────────┴───────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

---

## 5. Surface designs

### 5.1 Library

Grid of packages the author owns, plus **New** and **Import `.zip`**. Each card
shows name, description, cast size, and tier. New packages start from a
template (Blank / Duel / Investigation / Conversation) that pre-seeds a couple
of nodes and characters so the author is never staring at an empty canvas.

Maps to: `GET /api/experiences`, `POST /api/experiences/import`.

### 5.2 World map editor

**This is where a GUI decisively beats text.** `world.json` is a graph, and
`targetNodeId` is exactly the kind of thing nobody should hand-write.

- A canvas of **node cards** the author drags around. Dragging sets
  `localPosition` — which now defaults to the origin, so position is a
  convenience, not a requirement.
- **Drawing a line between two cards** creates the connection. Edges are
  bidirectional by default with a toggle for one-way, since a one-way edge is
  a real authoring intent (a drop, a locked door) and easy to create by
  accident otherwise.
- Selecting a node opens an inspector: name, description, type, and — under
  Advanced — `environmentalCodes`, with a clear distinction between
  *flavor* codes and `mechanical: true` codes that must name an `effectId`.
- **Regions** are containers, shown as a grouping frame. Most Experiences have
  exactly one; the UI should not force the author to think about the region
  grid unless they add a second.

Validation surfaced live on the canvas: unreachable nodes greyed with a
warning badge, dangling edges drawn in red.

### 5.3 Cast — character wizard

A short wizard rather than one long form, with each step skippable:

1. **Identity** — name, and optionally class/race/background/level.
2. **Voice** — `personality` and `tone`. These are the two fields that most
   determine play quality, so they get their own step with real examples and
   generous text areas, not a cramped input.
3. **Capability** *(Tier 2+)* — abilities and skills. Presented as a small
   set of named tracks, not a stat block; the six D&D defaults are just the
   default vocabulary and are fully replaceable per Experience.
4. **Gear & moves** *(Tier 2+)* — `techniques` and starting `inventory`,
   picked from this Experience's own catalog with an inline "create new" so
   the author isn't bounced to another screen mid-thought.
5. **Beats** *(Tier 3)* — character `plotPoints` on the timeline axis.

Placement (`startingNodeId`) is set by dropping the character onto a node in
the map editor, not by typing an id.

### 5.4 Systems

The advanced surface — three catalogs plus tuning:

- **Effects** — id, name, description, severity (1–5), and the stat deltas.
  Severity should be explained in-place as the escalation ceiling it actually
  is, since it's the least self-evident field in the schema.
- **Items** — consumable vs equipment, and their deltas.
- **Hazards** — the mechanical `environmentalCodes` placed in the map editor,
  listed here in one place so the author can see every automatic consequence
  in the world at a glance.
- **Tuning** — `difficulty.defaultTier` and the `escalation` config, with
  plain-language descriptions of what each knob does to play.

Built-in defaults (the standard abilities, skills, effects, and items) are
shown greyed as "inherited", with an explicit **Override** action — because
today the merge-over-defaults behavior is invisible and an author can easily
believe they replaced a default when they only added alongside it.

### 5.5 Playtest

Split view: editor left, play right, no publish step between them.

**Two modes**, and the second is the differentiator:

- **Narrative** — a real turn through the configured model. What the player
  will experience. Costs tokens, takes seconds.
- **Dry run** — *no model at all.* The author writes an explicit action
  (move / use technique / interact), and the engine runs only the
  deterministic layer: structural gates, the rules check, the dice roll, the
  effect application, the dtm write. Output is a mechanical trace —
  roll, modifier, DC, margin, outcome, resulting state — rendered as a table.

Dry run is instant, free, and reproducible, and it's the feature that makes
authoring serious: an author can prove a hazard fires, an item gates, or a DC
is reachable without playing a scene. It depends on **seeded RNG**
([§9](#9-open-decisions)), without which no run is repeatable.

### 5.6 Publish

Validate → export `.zip` → optionally publish. Export is the guaranteed path;
publishing to any shared gallery is a later concern with its own moderation
questions, and should not block the editor shipping.

---

## 6. Validation and error presentation

Authors must never see a raw Zod error. Every diagnostic gets a location (which
surface, which entity), a plain-language cause, and where possible a one-click
fix.

Two severities:

- **Errors** block export — an edge to a node that doesn't exist, a character
  placed on a missing node, a `mechanical: true` code with no `effectId`.
- **Warnings** don't block, but catch the legal-but-probably-wrong: a node with
  no connections, a character no placement references, an effect nothing uses,
  an `effectId` that silently resolved to a built-in default when the author
  likely meant their own.

That last warning matters disproportionately — it's invisible today and
produces a world that loads fine and plays wrong.

---

## 7. AI assistance

Scoped deliberately narrow: **drafting, never authority.**

- Draft a `personality`/`tone` from a one-line concept.
- Draft node descriptions from a name and a mood.
- Suggest a technique or effect consistent with the existing catalog.

Everything lands in an editable field the author confirms. The AI never writes
mechanical values silently, and never touches ids or references. It reuses the
already-configured backend, so it costs nothing extra to wire up.

---

## 8. API surface

Most read paths already exist. The creator's genuinely new requirement is
**write**.

| Need | Status |
|---|---|
| List packages | ✅ `GET /api/experiences` |
| Select package / character | ✅ `POST /api/experiences/select` |
| Import `.zip` | ✅ `POST /api/experiences/import` |
| Create a character | ✅ `POST /api/experiences/:id/characters` (point-buy shaped) |
| Play a turn / stream events | ✅ `POST /api/turn`, `GET /api/events` |
| Read current scope | ✅ `GET /api/scope` |
| **Create/update a package** | ❌ new |
| **Write world + characters** | ❌ new |
| **Export `.zip`** | ❌ new |
| **Validate without saving** | ❌ new |
| **Dry-run a mechanical action** | ❌ new — needs seeded RNG |

The existing character-creation endpoint is shaped around player-facing
point-buy, not authoring, so the creator likely needs its own write path rather
than reusing it.

---

## 9. Open decisions

These change the build materially and are the architect's call.

1. **Frontend stack.** Today's `frontend/` is one vanilla `app.js` (~44 KB),
   `index.html`, and `style.css`, with no build step. A graph canvas plus
   multi-step wizards will strain that. Options: stay vanilla and accept the
   weight; add a build step and a framework; or ship the creator as a separate
   app that shares only the design tokens.
2. **Where creations live.** HF Space filesystems are ephemeral — anything
   authored there is lost on rebuild. Options: browser-local with explicit
   export; real persistence behind the server; or creator-side-only with the
   Space used purely for playtesting.
3. **Same app or separate route?** Folding the creator into the player app
   keeps one deployment and one design system, but roughly doubles the
   frontend's surface area.
4. **Seeded RNG.** Required for dry run to be reproducible. Does the seed live
   on the Experience, the session, or a per-run control?
5. **Scope of v1.** The map editor alone would be a meaningful release. Is the
   first cut map-only, or map + cast?

---

## 10. Suggested build order

Each step is independently useful, so the work can stop at any point without
leaving a half-feature.

1. **Seeded RNG + dry-run engine path** — no UI. Backend-only, immediately
   useful for testing the engine itself, and the foundation for §5.5.
2. **Package write + export endpoints** — with author-facing validation (§6).
3. **World map editor** — the highest-value surface, and the clearest win
   over hand-editing.
4. **Cast wizard.**
5. **Systems panel.**
6. **Playtest split view**, wiring the dry run into the UI.
7. **AI assist**, last — it's polish, and it's meaningless before the fields
   it drafts into exist.
