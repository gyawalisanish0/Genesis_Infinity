import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExperienceSchema, type Experience } from "../schemas/experience.js";
import { WorldSchema, type World } from "../schemas/world.js";
import { CharacterSheetSchema, type CharacterSheet } from "../schemas/character.js";
import { resolveRulesetDefs } from "./character.js";
import type { AbilityDef, SkillDef } from "../schemas/character.js";

export interface LoadedExperience {
  experience: Experience;
  ruleset: { abilities: AbilityDef[]; skills: SkillDef[] };
  world: World;
  characters: CharacterSheet[];
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
 * Ruleset abilities/skills are resolved against the D&D defaults via
 * resolveRulesetDefs (per-entry fallback) before being returned.
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

  return { experience, ruleset, world, characters };
}
