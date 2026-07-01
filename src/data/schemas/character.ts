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
 */
export const TechniqueDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type TechniqueDef = z.infer<typeof TechniqueDefSchema>;

/**
 * A mechanical debuff/effect definition an Experience can declare — the
 * ruleset-level pool tools/'s escalation system (rejectAction) draws from
 * as punishment for a character's repeated invalid action attempts.
 * `severity` (1-5, same scale as world.ts's EnvironmentalCode) gates which
 * effects are eligible to be picked at a given strike count: escalation
 * only allows drawing from severities up to a ceiling that rises with the
 * strike count, so punishment trends harsher the longer it's ignored
 * without being fully deterministic. Deltas are restricted to
 * armorClass/hitPoints.max — the only numeric combat fields every
 * CharacterSheet is guaranteed to have.
 */
export const EffectDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  severity: z.number().int().min(1).max(5),
  armorClassDelta: z.number().int().optional(),
  maxHitPointsDelta: z.number().int().optional(),
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
 * The mechanical layer of a character — stats and skills used by rules/
 * for checks. Identity fields (class/race/background) are open strings,
 * not fixed enums, so non-fantasy settings aren't forced into D&D content.
 *
 * This is distinct from the broader Character entity (personality, tone,
 * timecoded plot points — see docs/ARCHITECTURE.md), which will combine
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
