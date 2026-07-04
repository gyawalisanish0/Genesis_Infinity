import { z } from "zod";
import { AbilityDefSchema, SkillDefSchema, EffectDefSchema, ItemDefSchema } from "./character.js";

/**
 * A character's starting placement in the world — the "location metadata"
 * an Experience bundles per docs/BACKEND_ARCHITECTURE.md. `characterId` must match
 * a CharacterSheet id; `startingNodeId` must reference a real node (cross-
 * world validation, since ExperienceSchema doesn't itself hold the world).
 */
export const CharacterPlacementSchema = z.object({
  characterId: z.string(),
  startingNodeId: z.string(),
});
export type CharacterPlacement = z.infer<typeof CharacterPlacementSchema>;

/**
 * Tunables for tools/'s escalation system (rejectAction) — all optional,
 * each falling back independently to DEFAULT_ESCALATION_CONFIG if not
 * declared. `maxSeverity` shares EffectDefSchema's 1-5 severity scale.
 * `debuffDurationUnits` is in timeline/ units (2 per real second, see
 * timeline/index.ts) — real-wall-clock-anchored, not turn count.
 */
export const EscalationConfigSchema = z.object({
  strikeThreshold: z.number().int().positive().optional(),
  maxSeverity: z.number().int().min(1).max(5).optional(),
  debuffDurationUnits: z.number().int().positive().optional(),
});
export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;

/** Engine defaults for any EscalationConfig field an Experience doesn't declare. */
export const DEFAULT_ESCALATION_CONFIG: Required<EscalationConfig> = {
  strikeThreshold: 3,
  maxSeverity: 5,
  // 60 timeline units = 30 real seconds at 2 units/sec.
  debuffDurationUnits: 60,
};

/** The six D&D-5e-inspired difficulty tiers rules/'s validator can name for a "skill" check (see rules/index.ts's RuleValidation.difficultyTier). */
export const DIFFICULTY_TIERS = ["trivial", "easy", "medium", "hard", "very-hard", "near-impossible"] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

/**
 * Tunable for ai/'s difficultyTierToDc — which tier stands in for a
 * "skill" check when rules/'s validator omits difficultyTier despite
 * naming checkKind "skill" (it's always instructed to include one; this
 * only matters if it doesn't). The DC-per-tier table itself
 * (trivial=5 ... near-impossible=30) is not Experience-configurable —
 * only which tier is the fallback.
 */
export const DifficultyConfigSchema = z.object({
  defaultTier: z.enum(DIFFICULTY_TIERS).optional(),
});
export type DifficultyConfig = z.infer<typeof DifficultyConfigSchema>;

/** Engine default for DifficultyConfig.defaultTier if an Experience doesn't declare one. */
export const DEFAULT_DIFFICULTY_CONFIG: Required<DifficultyConfig> = {
  defaultTier: "medium",
};

/**
 * Minimal Experience schema, scoped for now to the ability/skill/effect/item
 * ruleset declaration, escalation tuning, and character starting placement
 * — all optional, with abilities/skills/effects/items falling back to the
 * defaults (DEFAULT_ABILITIES / DEFAULT_SKILLS / DEFAULT_EFFECTS /
 * DEFAULT_ITEMS) via the resolver in data/loaders/character.ts, and
 * escalation falling back to DEFAULT_ESCALATION_CONFIG per-field in
 * data/loaders/experience.ts. The full Experience model (rulesets beyond
 * these, etc.) is deferred — see docs/BACKEND_ARCHITECTURE.md.
 */
export const ExperienceSchema = z.object({
  id: z.string(),
  name: z.string(),
  abilities: z.array(AbilityDefSchema).optional(),
  skills: z.array(SkillDefSchema).optional(),
  effects: z.array(EffectDefSchema).optional(),
  items: z.array(ItemDefSchema).optional(),
  escalation: EscalationConfigSchema.optional(),
  difficulty: DifficultyConfigSchema.optional(),
  characters: z.array(CharacterPlacementSchema).optional(),
});
export type Experience = z.infer<typeof ExperienceSchema>;
