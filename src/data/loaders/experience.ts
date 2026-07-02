import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ExperienceSchema,
  DEFAULT_ESCALATION_CONFIG,
  type Experience,
  type EscalationConfig,
} from "../schemas/experience.js";
import { WorldSchema, type World } from "../schemas/world.js";
import { CharacterSheetSchema, type CharacterSheet } from "../schemas/character.js";
import { resolveRulesetDefs } from "./character.js";
import type { AbilityDef, SkillDef, EffectDef, ItemDef } from "../schemas/character.js";

export interface LoadedExperience {
  experience: Experience;
  ruleset: { abilities: AbilityDef[]; skills: SkillDef[]; effects: EffectDef[]; items: ItemDef[] };
  escalation: Required<EscalationConfig>;
  world: World;
  characters: CharacterSheet[];
}

/**
 * Resolves an Experience's declared escalation config against the engine
 * defaults, per-field (not per-entry — this is a flat settings object, not
 * an id-keyed definition list like abilities/skills/effects).
 */
function resolveEscalationConfig(declared: EscalationConfig | undefined): Required<EscalationConfig> {
  return {
    strikeThreshold: declared?.strikeThreshold ?? DEFAULT_ESCALATION_CONFIG.strikeThreshold,
    maxSeverity: declared?.maxSeverity ?? DEFAULT_ESCALATION_CONFIG.maxSeverity,
    debuffDurationUnits: declared?.debuffDurationUnits ?? DEFAULT_ESCALATION_CONFIG.debuffDurationUnits,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8"));
}

/**
 * Loads an Experience directory of the form:
 *   <dir>/experience.json   (ExperienceSchema)
 *   <dir>/world.json        (WorldSchema)
 *   <dir>/characters/*.json (CharacterSheetSchema, one per file)
 *
 * Ruleset abilities/skills/effects/items are resolved against the defaults
 * via resolveRulesetDefs (per-entry fallback), and escalation tuning
 * against DEFAULT_ESCALATION_CONFIG (per-field fallback), before being
 * returned.
 */
export async function loadExperience(dir: string): Promise<LoadedExperience> {
  const experience = ExperienceSchema.parse(await readJson(join(dir, "experience.json")));
  const world = WorldSchema.parse(await readJson(join(dir, "world.json")));

  const charactersDir = join(dir, "characters");
  const characterFiles = (await readdir(charactersDir)).filter((file) => file.endsWith(".json"));
  const characters = await Promise.all(
    characterFiles.map(async (file) =>
      CharacterSheetSchema.parse(await readJson(join(charactersDir, file))),
    ),
  );

  const ruleset = resolveRulesetDefs(experience);
  const escalation = resolveEscalationConfig(experience.escalation);

  return { experience, ruleset, escalation, world, characters };
}
