import { z } from "zod";
import { AbilityDefSchema, SkillDefSchema, EffectDefSchema } from "./character.js";

/**
 * A character's starting placement in the world — the "location metadata"
 * an Experience bundles per docs/ARCHITECTURE.md. `characterId` must match
 * a CharacterSheet id; `startingNodeId` must reference a real node (cross-
 * world validation, since ExperienceSchema doesn't itself hold the world).
 */
export const CharacterPlacementSchema = z.object({
  characterId: z.string(),
  startingNodeId: z.string(),
});
export type CharacterPlacement = z.infer<typeof CharacterPlacementSchema>;

/**
 * Minimal Experience schema, scoped for now to the ability/skill/effect
 * ruleset declaration and character starting placement — all optional, with
 * abilities/skills/effects falling back to the D&D-style defaults
 * (DEFAULT_ABILITIES / DEFAULT_SKILLS / DEFAULT_EFFECTS) via the resolver in
 * data/loaders/character.ts. The full Experience model (rulesets beyond
 * these, etc.) is deferred — see docs/ARCHITECTURE.md.
 */
export const ExperienceSchema = z.object({
  id: z.string(),
  name: z.string(),
  abilities: z.array(AbilityDefSchema).optional(),
  skills: z.array(SkillDefSchema).optional(),
  effects: z.array(EffectDefSchema).optional(),
  characters: z.array(CharacterPlacementSchema).optional(),
});
export type Experience = z.infer<typeof ExperienceSchema>;
