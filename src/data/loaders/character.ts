import {
  AbilityDefSchema,
  SkillDefSchema,
  EffectDefSchema,
  DEFAULT_ABILITIES,
  DEFAULT_SKILLS,
  DEFAULT_EFFECTS,
  type AbilityDef,
  type SkillDef,
  type EffectDef,
} from "../schemas/character.js";

/**
 * Resolves an Experience's declared ability list against the D&D-style
 * defaults: each declared entry is validated individually, invalid or
 * duplicate-id entries are dropped, and any default id missing from the
 * valid set is filled in from DEFAULT_ABILITIES. This is "per-entry
 * fallback" — a single broken entry doesn't discard the whole list.
 */
export function resolveAbilityDefs(declared: unknown[] | undefined): AbilityDef[] {
  const resolved = new Map<string, AbilityDef>();

  for (const entry of declared ?? []) {
    const result = AbilityDefSchema.safeParse(entry);
    if (result.success && !resolved.has(result.data.id)) {
      resolved.set(result.data.id, result.data);
    }
  }

  for (const fallback of DEFAULT_ABILITIES) {
    if (!resolved.has(fallback.id)) {
      resolved.set(fallback.id, fallback);
    }
  }

  return Array.from(resolved.values());
}

/**
 * Resolves an Experience's declared skill list the same way as
 * resolveAbilityDefs, with one extra check: a skill entry whose
 * governingAbilityId doesn't match any id in the resolved ability set is
 * also treated as broken and dropped (falls back to the default skill of
 * the same id, if any).
 */
export function resolveSkillDefs(
  declared: unknown[] | undefined,
  resolvedAbilities: AbilityDef[],
): SkillDef[] {
  const abilityIds = new Set(resolvedAbilities.map((ability) => ability.id));
  const resolved = new Map<string, SkillDef>();

  for (const entry of declared ?? []) {
    const result = SkillDefSchema.safeParse(entry);
    if (
      result.success &&
      !resolved.has(result.data.id) &&
      (!result.data.governingAbilityId || abilityIds.has(result.data.governingAbilityId))
    ) {
      resolved.set(result.data.id, result.data);
    }
  }

  for (const fallback of DEFAULT_SKILLS) {
    if (!resolved.has(fallback.id)) {
      resolved.set(fallback.id, fallback);
    }
  }

  return Array.from(resolved.values());
}

/**
 * Resolves an Experience's declared effect list the same way as
 * resolveAbilityDefs — per-entry fallback, no cross-reference check needed
 * (effects don't reference abilities the way skills do).
 */
export function resolveEffectDefs(declared: unknown[] | undefined): EffectDef[] {
  const resolved = new Map<string, EffectDef>();

  for (const entry of declared ?? []) {
    const result = EffectDefSchema.safeParse(entry);
    if (result.success && !resolved.has(result.data.id)) {
      resolved.set(result.data.id, result.data);
    }
  }

  for (const fallback of DEFAULT_EFFECTS) {
    if (!resolved.has(fallback.id)) {
      resolved.set(fallback.id, fallback);
    }
  }

  return Array.from(resolved.values());
}

/**
 * Resolves ability, skill, and effect definitions for an Experience in one
 * call, since skill resolution depends on the resolved ability set.
 */
export function resolveRulesetDefs(experience: {
  abilities?: unknown[];
  skills?: unknown[];
  effects?: unknown[];
}): { abilities: AbilityDef[]; skills: SkillDef[]; effects: EffectDef[] } {
  const abilities = resolveAbilityDefs(experience.abilities);
  const skills = resolveSkillDefs(experience.skills, abilities);
  const effects = resolveEffectDefs(experience.effects);
  return { abilities, skills, effects };
}
