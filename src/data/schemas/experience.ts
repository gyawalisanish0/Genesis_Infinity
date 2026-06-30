import { z } from "zod";
import { AbilityDefSchema, SkillDefSchema } from "./character";

/**
 * Minimal Experience schema, scoped for now to the ability/skill ruleset
 * declaration only — both optional, falling back to the D&D-style defaults
 * (DEFAULT_ABILITIES / DEFAULT_SKILLS) via the resolver in
 * data/loaders/character.ts. The full Experience model (world, characters,
 * rulesets, mode) is deferred — see docs/ARCHITECTURE.md.
 */
export const ExperienceSchema = z.object({
  id: z.string(),
  name: z.string(),
  abilities: z.array(AbilityDefSchema).optional(),
  skills: z.array(SkillDefSchema).optional(),
});
export type Experience = z.infer<typeof ExperienceSchema>;
