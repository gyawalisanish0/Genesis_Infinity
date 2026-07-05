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
 * Single-player vs. multiplayer, as an Experience config field — not a
 * separate engine codepath (docs/BACKEND_ARCHITECTURE.md's Experience
 * Model). Schema-only today: the engine still runs exactly one connected
 * user per process; multi-user session routing remains deferred.
 */
export const ExperienceModeSchema = z.enum(["single-player", "multiplayer"]);
export type ExperienceMode = z.infer<typeof ExperienceModeSchema>;

/**
 * An Experience-level narrative plot point, along the two independent axes
 * docs/BACKEND_ARCHITECTURE.md's Narrative / Plot Points section defines:
 * - `authoring`: "hardcoded" (fixed, deterministic) or "soft-coded" (the
 *   AI has interpretive freedom within the description's bounds).
 * - `firing`: "trigger-based" (fires on a condition — `trigger`, a
 *   free-text condition description, required) or "timestamp-based"
 *   (fires at a timeline/ unit — `atUnit`, required).
 * Any pairing of the two axes is valid. Schema-only today: plot points
 * are validated, loaded, and available on LoadedExperience, but no engine
 * firing mechanism exists yet — trigger/timestamp firing is its own
 * deferred design (likely tied to scheduler/).
 */
export const PlotPointSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    authoring: z.enum(["hardcoded", "soft-coded"]),
    firing: z.enum(["trigger-based", "timestamp-based"]),
    trigger: z.string().optional(),
    atUnit: z.number().int().nonnegative().optional(),
  })
  .superRefine((point, ctx) => {
    if (point.firing === "trigger-based" && point.trigger === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Plot point "${point.id}" is trigger-based but declares no trigger`,
        path: ["trigger"],
      });
    }
    if (point.firing === "timestamp-based" && point.atUnit === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Plot point "${point.id}" is timestamp-based but declares no atUnit`,
        path: ["atUnit"],
      });
    }
  });
export type PlotPoint = z.infer<typeof PlotPointSchema>;

/**
 * The Experience schema — the manifest of a playable package. The
 * package-manifest fields (`version`/`description`/`author`) live directly
 * on the Experience rather than in a separate manifest file, so a package
 * has exactly one source of identity (no second file whose `id` could
 * disagree — see src/packages/index.ts's discovery, which reads these
 * straight off experience.json). Ruleset declarations
 * (abilities/skills/effects/items), escalation and difficulty tuning, and
 * character starting placement are all optional, falling back to engine
 * defaults via data/loaders/. `playerCharacterId` optionally names which
 * character the connected player controls by default when this Experience
 * is selected at runtime (see server/'s resolvePlayerCharacterId fallback
 * chain); `mode` and `plotPoints` are schema-only today (see their own
 * doc comments above).
 */
export const ExperienceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    mode: ExperienceModeSchema.optional(),
    playerCharacterId: z.string().optional(),
    abilities: z.array(AbilityDefSchema).optional(),
    skills: z.array(SkillDefSchema).optional(),
    effects: z.array(EffectDefSchema).optional(),
    items: z.array(ItemDefSchema).optional(),
    escalation: EscalationConfigSchema.optional(),
    difficulty: DifficultyConfigSchema.optional(),
    characters: z.array(CharacterPlacementSchema).optional(),
    plotPoints: z.array(PlotPointSchema).optional(),
  })
  .superRefine((experience, ctx) => {
    const plotPointIds = new Set<string>();
    for (const point of experience.plotPoints ?? []) {
      if (plotPointIds.has(point.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate plot point id "${point.id}"`,
        });
      }
      plotPointIds.add(point.id);
    }
  });
export type Experience = z.infer<typeof ExperienceSchema>;
