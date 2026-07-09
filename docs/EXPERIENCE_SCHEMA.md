# Authoring Experiences — the package schema contract

An **Experience** is a self-contained, playable package: one world, a cast
of characters, and the rules that bind them. This is the complete reference
for authoring one by hand. Everything here is enforced by the loader
(`src/data/loaders/`) through Zod schemas — if a package violates the
contract, it fails to load with a specific error rather than misbehaving at
runtime.

> New to the engine? Read this top-to-bottom once, then keep the
> [Field reference](#field-reference) and [Cross-file contracts](#cross-file-contracts)
> open while you write. A [minimal complete example](#a-minimal-complete-example)
> is at the end.

---

## Package layout

A package is a directory. Its name is cosmetic — identity comes from the
`id` fields inside, not the folder.

```
my-experience/
├── experience.json      # the manifest: identity, ruleset, tuning, cast placement
├── world.json           # the map: regions → nodes → connections
└── characters/
    ├── hero.json        # one CharacterSheet per file
    └── rival.json
```

- **`experience.json`** and **`world.json`** are required, exactly one each.
- **`characters/`** holds one `*.json` file per character. The filename is
  cosmetic; the character's `id` field is what everything references.
- A `dtm.json` file appears next to these once the Experience is played —
  it's the derived event log (positions, HP, inventory changes over time).
  Don't author it; don't ship it. It's created on first run.

A package can be **imported at runtime** as a `.zip` of exactly this layout
(the three items at the zip root, or under a single top-level folder). See
`docs/BACKEND_ARCHITECTURE.md`'s Experience Packages section.

---

## The three-layer model

Every value a character has splits across three layers. Understanding this
split is the key to authoring correctly:

1. **The ruleset** (declared in `experience.json`): the *vocabulary* —
   which abilities, skills, effects, and items exist in this Experience.
   Definitions only: an ability is `{id, name}`, no score.
2. **The sheet** (`characters/*.json`): a character's *static* starting
   values against that vocabulary — ability scores, skill values, starting
   HP/AC, starting inventory, known techniques.
3. **Derived state** (never authored — computed from the event log): where a
   character *currently* is, their *current* HP, what they're *currently*
   carrying. The sheet is the starting snapshot; play moves it.

You author layers 1 and 2. The engine owns layer 3. This is why, for
example, you set a character's *starting* inventory on the sheet but never
their current inventory — that's derived.

### Ruleset resolution (per-entry fallback)

`abilities`, `skills`, `effects`, and `items` on `experience.json` are all
**optional**. When omitted, the engine uses a built-in D&D-style default
(`DEFAULT_ABILITIES`, `DEFAULT_SKILLS`, `DEFAULT_EFFECTS`, `DEFAULT_ITEMS` in
`src/data/schemas/character.ts`). Resolution is **per-entry fallback that
merges with the defaults**, keyed by id:

- Every entry you declare is added to the resolved set.
- A declared entry whose `id` matches a default **overrides** that default.
- Every default id you *don't* override **remains available**.

So the defaults are always there unless you replace them by id. To add one
custom ability alongside the six standard ones, declare just the custom one —
you keep all six defaults for free. This also means you can freely reference
the built-in items (`health-potion`, `iron-shield`) and effects (`exposed`,
`weakened`, `battered`) even in an Experience that declares its own, without
re-declaring them. (For skills, a declared skill whose `governingAbilityId`
isn't in the resolved ability set is dropped — see the loader.)

---

## Field reference

### `experience.json` — the manifest

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | ✓ | Stable unique identifier for the package. |
| `name` | string | ✓ | Display name (shown in the Experiences picker). |
| `version` | string | – | Free-form, e.g. `"1.0.0"`. Manifest metadata. |
| `description` | string | – | One-line summary for the picker. |
| `author` | string | – | Your name/handle. |
| `mode` | `"single-player"` \| `"multiplayer"` | – | **Schema-only today** — the engine runs one player per process regardless. |
| `playerCharacterId` | string | – | Which character the player controls by default. Must match a sheet `id`. If omitted, the server picks via a fallback chain. |
| `abilities` | AbilityDef[] | – | Ruleset vocabulary. `{id, name}`. Defaults to the six D&D abilities. |
| `skills` | SkillDef[] | – | `{id, name, governingAbilityId?}`. Defaults to the 18 D&D skills. |
| `effects` | EffectDef[] | – | Mechanical effect pool (see [Effects](#effects)). Defaults to a small pool. |
| `items` | ItemDef[] | – | Item catalog (see [Items](#items)). Defaults to a small catalog. |
| `escalation` | EscalationConfig | – | Tuning for the repeated-invalid-action penalty (see [Escalation](#escalation)). |
| `difficulty` | DifficultyConfig | – | Fallback difficulty tier for skill checks (see [Difficulty](#difficulty)). |
| `characters` | CharacterPlacement[] | – | `{characterId, startingNodeId}` — **where each character starts**. See the [placement contract](#cross-file-contracts). |
| `plotPoints` | PlotPoint[] | – | Experience-level narrative beats. **Schema-only today** (validated & loaded, no firing engine yet). |
| `customCharacter` | CustomCharacterConfig | – | Opt-in to player-built characters (see [Custom characters](#custom-characters)). Presence = opted in; there is no default. |

### `world.json` — the map

The world is a grid of **regions** (macro travel units); each region holds
**nodes** (the actual visitable places); nodes link via **edges**.

**World**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | ✓ | Unique world id. |
| `name` | string | ✓ | Display name. |
| `width` / `height` | int > 0 | ✓ | World grid size. Every region's `position` must fall inside it. |
| `regions` | Region[] | – | Defaults to empty. |

**Region**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | ✓ | Unique across the world. |
| `position` | `{x, y}` | ✓ | Cell on the world grid; must be within `width`×`height`. |
| `name` | string | ✓ | |
| `description` | string | – | |
| `worldType` | `"narrative-bound"` \| `"semi-open"` \| `"open"` | ✓ | How freely the player can roam this region. |
| `environmentalCodes` | EnvironmentalCode[] | – | Region-wide conditions (see [Environmental codes](#environmental-codes)). |
| `nodes` | Node[] | – | Defaults to empty. |

**Node**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | ✓ | **Unique across the entire world**, not just its region (edges can cross regions). |
| `name` | string | ✓ | |
| `description` | string | ✓ | What the player sees on arrival — write this well; it's the AI's scene anchor. |
| `type` | string | ✓ | Open string (e.g. `"battlefield"`, `"street"`, `"chamber"`). |
| `layer` | int | – | Disambiguates nodes sharing a `localPosition` (e.g. surface vs. basement). |
| `localPosition` | `{x, y}` | ✓ | Position within the region's own (unbounded) sub-grid. Drives computed compass directions between nodes. |
| `environmentalCodes` | EnvironmentalCode[] | – | Node-specific conditions; **merge over** the region's by `(category, value)`. |
| `connections` | Edge[] | – | `{targetNodeId, direction?}`. Defaults to empty. Direction is auto-computed from positions unless you override it (e.g. for a portal). |

### `characters/*.json` — a CharacterSheet

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | ✓ | Unique. Referenced by `characters[].characterId` and `playerCharacterId`. |
| `name` | string | ✓ | |
| `class` / `race` / `background` | string | – | **Open strings, not enums** — non-fantasy settings are fine. |
| `level` | int > 0 | – | |
| `personality` | string | – | Drives how the AI voices the character. Reaches the model via `get_character_sheet`. |
| `tone` | string | – | Speech register / narrative voice for this character. |
| `abilities` | AbilityScore[] | ✓ | `{id, name, score}`. Ids should match the ruleset's abilities. |
| `skills` | Skill[] | ✓ | `{id, name, governingAbilityId?, value}`. |
| `techniques` | TechniqueDef[] | – | Known techniques — the **hard capability gate** for the `use_technique` action (see [Techniques](#techniques)). Defaults to empty. |
| `inventory` | InventoryEntry[] | – | **Starting** inventory: `{itemId, quantity, equipped?}`. Defaults to empty. |
| `hitPoints` | `{current, max}` | – | Starting HP. `max` must be > 0. |
| `armorClass` | number | – | Starting AC. |
| `plotPoints` | CharacterPlotPoint[] | – | `{id, description, atUnit}` — this character's own timecoded arc. **Schema-only today.** |

---

## Mechanics reference

### Techniques

A technique is a named capability on a character's sheet. A character can
**only attempt a technique that appears in their `techniques` list** — this
is checked structurally, before the attempt reaches the AI rules layer.

```json
{
  "id": "instant-transmission",
  "name": "Instant Transmission",
  "description": "Teleport to any target the user can sense.",
  "effectId": "concussed",
  "relocatesToTarget": true
}
```

- `effectId` (optional) — references an entry in this Experience's `effects`
  pool. Applied to the target when the technique lands as a full success.
  Omit it for a narration-only technique with no mechanical consequence yet.
- `relocatesToTarget` (optional) — if `true`, landing this technique on a
  named target also moves the user onto the target's node, bypassing the
  normal `move` action's adjacency check.

### Effects

An effect is a reusable mechanical consequence, drawn on by (a) the
escalation penalty, (b) mechanical environmental codes, and (c) technique
`effectId`s. `severity` (1–5) gates which effects escalation may pick at a
given strike count.

```json
{
  "id": "concussed",
  "name": "Concussed",
  "description": "Reeling from the hit — guard dropped.",
  "severity": 3,
  "armorClassDelta": -2,
  "maxHitPointsDelta": -5,
  "currentHitPointsDelta": -10
}
```

Two delta kinds, applied differently:

- `armorClassDelta` / `maxHitPointsDelta` — **ongoing** modifiers, active
  only while the effect hasn't expired (duration is timeline-based, see
  [Escalation](#escalation)). A standing penalty, recomputed each state read.
- `currentHitPointsDelta` — a **permanent one-shot**. Negative = damage,
  positive = a heal. Logged once and accumulates forever (it doesn't "wear
  off" the way a standing penalty does).

### Items

A shared catalog (items are generic — a Health Potion means the same for
everyone who carries one). `type` decides how using it (via the `interact`
action's `itemId`) behaves:

```json
{ "id": "health-potion", "name": "Health Potion", "description": "...", "type": "consumable", "healAmount": 20 }
{ "id": "iron-shield",  "name": "Iron Shield",   "description": "...", "type": "equipment",  "armorClassDelta": 2 }
```

- `"consumable"` — `healAmount` is applied once to current HP, then quantity
  decrements. Permanent, not a decaying effect.
- `"equipment"` — `armorClassDelta` / `maxHitPointsDelta` apply as a
  standing modifier while equipped (toggled each use), removed when
  unequipped.

Fields are only meaningful for their `type`.

### Environmental codes

A condition on a region or node (climate, hazard, lighting, curse…).

```json
{ "category": "radiation", "value": "lethal", "severity": 4, "mechanical": true, "effectId": "irradiated", "description": "..." }
```

- `category` / `value` — open strings; the pair is the merge key
  (node overrides region).
- `mechanical` — if `true`, `effectId` is **required** and references an
  effect applied on arrival. If `false`, it's narrative flavor only.

### Escalation

Tuning for the penalty applied when a player repeatedly attempts invalid
actions. All fields optional; each falls back independently.

```json
{ "strikeThreshold": 3, "maxSeverity": 5, "debuffDurationUnits": 60 }
```

- `strikeThreshold` — invalid attempts before a penalty lands (default 3).
- `maxSeverity` — highest effect severity escalation may pick (1–5, default 5).
- `debuffDurationUnits` — how long applied debuffs last, in **timeline
  units** (2 per real second; default 60 = 30s). Wall-clock-anchored, not
  turn-count.

### Difficulty

```json
{ "defaultTier": "medium" }
```

Only sets which tier stands in for a skill check when the rules layer names
a `"skill"` check but omits a tier. Tiers: `trivial`, `easy`, `medium`,
`hard`, `very-hard`, `near-impossible`. The DC-per-tier table itself is not
configurable.

### Custom characters

Declaring `customCharacter` opts the Experience into player-built
characters. The author fixes placement/HP/AC; the player allocates
abilities/skills via two point-buy pools.

```json
{
  "startingNodeId": "town-square",
  "hitPoints": { "max": 30 },
  "armorClass": 12,
  "abilityPointBuy": { "floor": 8, "cap": 15, "pool": 10 },
  "skillPointBuy":   { "floor": 0, "cap": 5,  "pool": 8 }
}
```

Point-buy: every ability/skill starts at `floor`, may be raised up to `cap`,
and the sum of `(allocated − floor)` across all of them must not exceed
`pool`. Validated against **this Experience's resolved ruleset**, so it
covers every ability/skill the ruleset declares.

---

## Cross-file contracts

These span multiple files, so a single file can look valid in isolation yet
still fail to load. Contracts 1–5 and 7–8 are checked at load time (with a
specific error); contract 6 is enforced at runtime, not load — see the note
below it:

1. **Character placement.** Every character that should exist in play needs a
   `{characterId, startingNodeId}` entry in `experience.json`'s `characters`
   array. A sheet with no placement entry throws `Character "X" has no
   starting placement` at first state read — placement is not optional in
   practice even though the array field is. `characterId` must match a sheet
   `id`; `startingNodeId` must match a real `world.json` node id.
2. **`playerCharacterId`** (if set) must match a sheet `id`.
3. **Node ids are globally unique** across the whole world (edges cross
   regions).
4. **Every edge `targetNodeId`** must reference a real node.
5. **Every region `position`** must fall within the world's `width`×`height`.
6. **Every `effectId`** — on a technique, an environmental code, or picked by
   escalation — should reference an effect in the resolved `effects` pool.
   A `mechanical: true` environmental code *must* declare an `effectId` (a
   load-time check), but whether that id (or a technique's `effectId`)
   actually resolves to a pool entry is **not** verified at load — a dangling
   reference surfaces when the effect is applied at runtime, not on load.
7. **`skill.governingAbilityId`** (if set) must match an ability **on the
   same sheet** (schema check) *and* one in the resolved ability set — a
   skill whose governing ability isn't in the ruleset is dropped by the
   character loader.
8. **No duplicate ids** within any list (regions, nodes, abilities, skills,
   techniques, inventory items, plot points).

> Note: `startingNodeId` is not validated *at load time* against the world
> (the Experience schema doesn't hold the world), so a typo surfaces as a
> runtime error on first state read, not a load error. Double-check node ids.

---

## A minimal complete example

A one-region, two-node world with a single playable character using the
default ruleset (no custom abilities/skills/effects/items).

**`experience.json`**
```json
{
  "id": "first-steps",
  "name": "First Steps",
  "version": "1.0.0",
  "description": "A tiny starter Experience.",
  "author": "you",
  "playerCharacterId": "wanderer",
  "characters": [
    { "characterId": "wanderer", "startingNodeId": "crossroads" }
  ]
}
```

**`world.json`**
```json
{
  "id": "waylands",
  "name": "The Waylands",
  "width": 3,
  "height": 3,
  "regions": [
    {
      "id": "the-vale",
      "position": { "x": 1, "y": 1 },
      "name": "The Vale",
      "worldType": "semi-open",
      "nodes": [
        {
          "id": "crossroads",
          "name": "The Crossroads",
          "description": "Four dirt roads meet beneath a leaning signpost.",
          "type": "junction",
          "localPosition": { "x": 0, "y": 0 },
          "connections": [{ "targetNodeId": "old-well" }]
        },
        {
          "id": "old-well",
          "name": "The Old Well",
          "description": "A mossy stone well, its bucket long gone.",
          "type": "landmark",
          "localPosition": { "x": 1, "y": 0 },
          "connections": [{ "targetNodeId": "crossroads" }]
        }
      ]
    }
  ]
}
```

**`characters/wanderer.json`**
```json
{
  "id": "wanderer",
  "name": "The Wanderer",
  "class": "Traveler",
  "personality": "Curious, cautious, quick to help.",
  "tone": "Warm and understated.",
  "abilities": [
    { "id": "str", "name": "Strength", "score": 11 },
    { "id": "dex", "name": "Dexterity", "score": 13 },
    { "id": "con", "name": "Constitution", "score": 12 },
    { "id": "int", "name": "Intelligence", "score": 10 },
    { "id": "wis", "name": "Wisdom", "score": 14 },
    { "id": "cha", "name": "Charisma", "score": 12 }
  ],
  "skills": [
    { "id": "perception", "name": "Perception", "governingAbilityId": "wis", "value": 4 },
    { "id": "survival", "name": "Survival", "governingAbilityId": "wis", "value": 3 }
  ],
  "hitPoints": { "current": 24, "max": 24 },
  "armorClass": 12
}
```

That's a complete, loadable package. Add regions, characters, a custom
ruleset, techniques, items, and effects from the references above to grow it
into a full Experience.

---

## Validating your package

The fastest check is to load it. The loader runs full Zod validation and all
the cross-file contracts, and reports the first failure with a specific
message. See `docs/BACKEND_ARCHITECTURE.md` for how packages are discovered,
loaded, and imported at runtime.
