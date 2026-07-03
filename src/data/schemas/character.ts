import { z } from "zod";

/**
 * Shape of an ability *definition* (id + name only — no score). This is
 * what an Experience declares as part of its ruleset; actual character
 * data (AbilityScoreSchema) adds a score on top of one of these.
 */
export const AbilityDefSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type AbilityDef = z.infer<typeof AbilityDefSchema>;

/**
 * Shape of a skill *definition* (id + name + optional governing ability id
 * — no value). What an Experience declares as part of its ruleset; actual
 * character data (SkillSchema) adds a value on top of one of these.
 */
export const SkillDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  governingAbilityId: z.string().optional(),
});
export type SkillDef = z.infer<typeof SkillDefSchema>;

/**
 * D&D-style baseline. Experiences can use this as-is, override individual
 * entries, or add entirely custom abilities — CharacterSheetSchema does not
 * enforce this list, it's just a starting template for content authors.
 */
export const DEFAULT_ABILITIES = [
  { id: "str", name: "Strength" },
  { id: "dex", name: "Dexterity" },
  { id: "con", name: "Constitution" },
  { id: "int", name: "Intelligence" },
  { id: "wis", name: "Wisdom" },
  { id: "cha", name: "Charisma" },
] as const;

/**
 * D&D-style baseline skill list, each tied to a governing ability id from
 * DEFAULT_ABILITIES. Like abilities, this is a template, not an enforced
 * list — Experiences can override or add their own.
 */
export const DEFAULT_SKILLS = [
  { id: "acrobatics", name: "Acrobatics", governingAbilityId: "dex" },
  { id: "animal-handling", name: "Animal Handling", governingAbilityId: "wis" },
  { id: "arcana", name: "Arcana", governingAbilityId: "int" },
  { id: "athletics", name: "Athletics", governingAbilityId: "str" },
  { id: "deception", name: "Deception", governingAbilityId: "cha" },
  { id: "history", name: "History", governingAbilityId: "int" },
  { id: "insight", name: "Insight", governingAbilityId: "wis" },
  { id: "intimidation", name: "Intimidation", governingAbilityId: "cha" },
  { id: "investigation", name: "Investigation", governingAbilityId: "int" },
  { id: "medicine", name: "Medicine", governingAbilityId: "wis" },
  { id: "nature", name: "Nature", governingAbilityId: "int" },
  { id: "perception", name: "Perception", governingAbilityId: "wis" },
  { id: "performance", name: "Performance", governingAbilityId: "cha" },
  { id: "persuasion", name: "Persuasion", governingAbilityId: "cha" },
  { id: "religion", name: "Religion", governingAbilityId: "int" },
  { id: "sleight-of-hand", name: "Sleight of Hand", governingAbilityId: "dex" },
  { id: "stealth", name: "Stealth", governingAbilityId: "dex" },
  { id: "survival", name: "Survival", governingAbilityId: "wis" },
] as const;

/**
 * A single ability score. `score` is a raw stored value — no D&D-style
 * modifier formula is computed here; if rules/ needs a modifier, it derives
 * one at resolution time rather than the schema baking in a formula.
 */
export const AbilityScoreSchema = z.object({
  id: z.string(),
  name: z.string(),
  score: z.number(),
});
export type AbilityScore = z.infer<typeof AbilityScoreSchema>;

/**
 * A single skill. `value` is a raw stored value (not derived from ability
 * score + proficiency bonus). `governingAbilityId` is informational —
 * it records which ability a skill is associated with, for reference and
 * narrative use, without implying any computed relationship.
 */
export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  governingAbilityId: z.string().optional(),
  value: z.number(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const HitPointsSchema = z.object({
  current: z.number().int(),
  max: z.number().int().positive(),
});
export type HitPoints = z.infer<typeof HitPointsSchema>;

/**
 * A named technique/ability a character actually knows, with a short
 * description. This is the hard capability gate for tools/'s use_technique
 * action: a character can only attempt a technique that appears in this
 * list — checked structurally, before the attempt ever reaches rules/.
 *
 * `effectId` is optional and references an entry in the Experience's
 * resolved effect pool (loaded.ruleset.effects) — the technique's
 * pre-authored mechanical consequence on its target, applied by
 * tools/'s applyUseTechnique when the attempt resolves as a full
 * success. A technique with no `effectId` has no defined mechanical
 * consequence yet (narration-only) — see docs/BACKEND_ARCHITECTURE.md's
 * Effects & Mechanical Grounding section.
 *
 * `relocatesToTarget` is optional and declares that landing this
 * technique on a named target also moves the actor onto the target's
 * current node (e.g. Instant Transmission) — applied by tools/'s
 * applyUseTechnique the same way `effectId` is, bypassing the separate
 * `move` action's graph-adjacency check entirely, since a technique like
 * this is defined by not needing an adjacent path. A technique with no
 * `relocatesToTarget` never moves its user — narration-only, same as
 * before this existed.
 */
export const TechniqueDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  effectId: z.string().optional(),
  relocatesToTarget: z.boolean().optional(),
});
export type TechniqueDef = z.infer<typeof TechniqueDefSchema>;

/**
 * A mechanical effect definition an Experience can declare — drawn on by
 * tools/'s escalation system (rejectAction) as punishment for repeated
 * invalid action attempts, by mechanical EnvironmentalCodes (world.ts) on
 * arrival at a hazardous node, and by TechniqueDefSchema's `effectId` when
 * a technique lands on a target. `severity` (1-5, same scale as world.ts's
 * EnvironmentalCode) gates which effects are eligible to be picked at a
 * given escalation strike count.
 *
 * Two different kinds of deltas, applied through two different mechanisms
 * (see tools/'s applyEffect):
 * - `armorClassDelta`/`maxHitPointsDelta` are *ongoing* modifiers — active
 *   only while the effect hasn't expired (state/'s AppliedDebuff, timeline-
 *   based duration), recomputed fresh on every state read. A standing
 *   penalty, not a one-time change.
 * - `currentHitPointsDelta` is a *permanent, one-shot* contribution — a
 *   hit landing doesn't heal itself back once its "debuff" expires the way
 *   a standing armor penalty would. Negative is damage, positive is a
 *   direct heal-like effect; it's logged once (an `effect.applied` dtm
 *   event) and accumulates forever, the same way item-based healing
 *   already does (see state/'s computeEffectiveStats).
 */
export const EffectDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  severity: z.number().int().min(1).max(5),
  armorClassDelta: z.number().int().optional(),
  maxHitPointsDelta: z.number().int().optional(),
  currentHitPointsDelta: z.number().int().optional(),
});
export type EffectDef = z.infer<typeof EffectDefSchema>;

/**
 * Fallback effect pool for Experiences that don't declare their own —
 * resolved the same "per-entry fallback" way as DEFAULT_ABILITIES/
 * DEFAULT_SKILLS (see data/loaders/character.ts's resolveEffectDefs).
 */
export const DEFAULT_EFFECTS: EffectDef[] = [
  {
    id: "exposed",
    name: "Exposed",
    description: "A conspicuous opening in their guard from the failed attempt.",
    severity: 1,
    armorClassDelta: -2,
  },
  {
    id: "weakened",
    name: "Weakened",
    description: "The failed attempt saps their stamina.",
    severity: 2,
    maxHitPointsDelta: -5,
  },
  {
    id: "battered",
    name: "Battered",
    description: "Repeated failure leaves them off-balance and worn down.",
    severity: 3,
    armorClassDelta: -1,
    maxHitPointsDelta: -3,
  },
];

/**
 * A carriable item definition an Experience can declare — a shared catalog
 * (unlike techniques, which are per-character with no template) since items
 * are usually generic: "Health Potion" means the same thing for every
 * character who carries one. `type` determines how `tools/`'s
 * `applyItemUse` treats it on use via `interact`'s `itemId`:
 * - `"consumable"` — `healAmount` (if set) is applied once, instantly, to
 *   current HP, then the item's quantity is decremented. Permanent, not a
 *   decaying effect the way escalation debuffs/hazards are.
 * - `"equipment"` — `armorClassDelta`/`maxHitPointsDelta` apply as a
 *   standing modifier for as long as the item is equipped (toggled on
 *   each use), removed the moment it's unequipped. Not time-based at all.
 * Fields are only meaningful for the type they document; the schema stays
 * flat (not a discriminated union) for consistency with `EffectDefSchema`.
 */
export const ItemDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(["consumable", "equipment"]),
  armorClassDelta: z.number().int().optional(),
  maxHitPointsDelta: z.number().int().optional(),
  healAmount: z.number().int().positive().optional(),
});
export type ItemDef = z.infer<typeof ItemDefSchema>;

/**
 * Fallback item catalog for Experiences that don't declare their own —
 * resolved the same "per-entry fallback" way as DEFAULT_EFFECTS (see
 * data/loaders/character.ts's resolveItemDefs).
 */
export const DEFAULT_ITEMS: ItemDef[] = [
  {
    id: "health-potion",
    name: "Health Potion",
    description: "A vial of restorative liquid.",
    type: "consumable",
    healAmount: 20,
  },
  {
    id: "iron-shield",
    name: "Iron Shield",
    description: "A sturdy shield that deflects incoming blows while carried.",
    type: "equipment",
    armorClassDelta: 2,
  },
];

/**
 * A character's carried quantity of a catalog item, plus whether it's
 * currently equipped (meaningful only for `type: "equipment"` items —
 * consumables are used up, not worn). This is the character's *starting*
 * inventory; actual current quantity/equipped state is derived from dtm/
 * (see state/index.ts), the same "sheet is static, state is derived"
 * pattern used for position and hit points.
 */
export const InventoryEntrySchema = z.object({
  itemId: z.string(),
  quantity: z.number().int().nonnegative(),
  equipped: z.boolean().optional(),
});
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;

/**
 * The mechanical layer of a character — stats and skills used by rules/
 * for checks. Identity fields (class/race/background) are open strings,
 * not fixed enums, so non-fantasy settings aren't forced into D&D content.
 *
 * This is distinct from the broader Character entity (personality, tone,
 * timecoded plot points — see docs/BACKEND_ARCHITECTURE.md), which will combine
 * this sheet with narrative fields in a later pass.
 */
export const CharacterSheetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    class: z.string().optional(),
    race: z.string().optional(),
    background: z.string().optional(),
    level: z.number().int().positive().optional(),
    abilities: z.array(AbilityScoreSchema),
    skills: z.array(SkillSchema),
    techniques: z.array(TechniqueDefSchema).default([]),
    inventory: z.array(InventoryEntrySchema).default([]),
    hitPoints: HitPointsSchema.optional(),
    armorClass: z.number().optional(),
  })
  .superRefine((sheet, ctx) => {
    const techniqueIds = new Set<string>();
    for (const technique of sheet.techniques) {
      if (techniqueIds.has(technique.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate technique id "${technique.id}"`,
        });
      }
      techniqueIds.add(technique.id);
    }

    const inventoryItemIds = new Set<string>();
    for (const entry of sheet.inventory) {
      if (inventoryItemIds.has(entry.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate inventory item id "${entry.itemId}"`,
        });
      }
      inventoryItemIds.add(entry.itemId);
    }

    const abilityIds = new Set<string>();
    for (const ability of sheet.abilities) {
      if (abilityIds.has(ability.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate ability id "${ability.id}"`,
        });
      }
      abilityIds.add(ability.id);
    }

    const skillIds = new Set<string>();
    for (const skill of sheet.skills) {
      if (skillIds.has(skill.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate skill id "${skill.id}"`,
        });
      }
      skillIds.add(skill.id);

      if (skill.governingAbilityId && !abilityIds.has(skill.governingAbilityId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Skill "${skill.id}" references unknown ability "${skill.governingAbilityId}"`,
        });
      }
    }
  });
export type CharacterSheet = z.infer<typeof CharacterSheetSchema>;
