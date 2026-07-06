import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { loadExperience, type LoadedExperience } from "../data/loaders/experience.js";
import type { ExperienceMode, PointBuy } from "../data/schemas/experience.js";
import { CharacterSheetSchema, type CharacterSheet } from "../data/schemas/character.js";

/**
 * A discovered, fully-valid Experience package — the listing shape
 * GET /api/experiences serves. All metadata comes straight off the
 * package's own experience.json (the manifest fields live on the
 * Experience itself — one source of identity, no separate manifest file
 * whose id could disagree).
 */
export interface PackageInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  mode: ExperienceMode;
  /** Absolute-or-relative directory the package loads from (loadExperience's dir). */
  dir: string;
  /**
   * Every pre-authored character in this package (id + name only) — lets
   * a client offer "play as X" as a real picker instead of the player
   * having to know/type a character id (see server/'s POST
   * /api/experiences/select, which accepts an optional characterId
   * drawn from this same list).
   */
  characters: { id: string; name: string }[];
  /**
   * Present iff this Experience opts into player-built characters (see
   * ExperienceSchema's customCharacter field and createCustomCharacter
   * below) — enough for a client to render a point-buy form with no
   * second request: the two pools, plus the id/name of every ability and
   * skill in this Experience's own resolved ruleset (the allocation
   * target, not the pool's own bounds).
   */
  customCharacter?: {
    abilityPointBuy: PointBuy;
    skillPointBuy: PointBuy;
    abilities: { id: string; name: string }[];
    skills: { id: string; name: string }[];
  };
}

/** Builds a PackageInfo from an already-loaded Experience — the shared tail of discoverPackages and importPackageZip. */
function toPackageInfo(loaded: LoadedExperience, dir: string): PackageInfo {
  return {
    id: loaded.experience.id,
    name: loaded.experience.name,
    version: loaded.experience.version,
    description: loaded.experience.description,
    author: loaded.experience.author,
    mode: loaded.mode,
    dir,
    characters: loaded.characters.map((c) => ({ id: c.id, name: c.name })),
    customCharacter: loaded.experience.customCharacter
      ? {
          abilityPointBuy: loaded.experience.customCharacter.abilityPointBuy,
          skillPointBuy: loaded.experience.customCharacter.skillPointBuy,
          abilities: loaded.ruleset.abilities.map((a) => ({ id: a.id, name: a.name })),
          skills: loaded.ruleset.skills.map((s) => ({ id: s.id, name: s.name })),
        }
      : undefined,
  };
}

/**
 * Import guardrails — a package is a handful of small JSON files, so
 * these caps are generous for real content while keeping a hostile
 * zip-bomb/energy-drain upload bounded. Entry paths are additionally
 * validated against traversal (see safeEntryPath).
 */
const MAX_ZIP_ENTRIES = 200;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

/**
 * Scans each root directory's immediate subdirectories for valid
 * Experience packages — "valid" meaning the whole package actually loads
 * (experience.json + world.json + characters/*, full Zod validation via
 * loadExperience), not just that a manifest parses. An invalid or
 * partially-authored directory is skipped silently rather than failing
 * the listing; a missing root is treated as empty. Roots are scanned in
 * order and the first package to claim an id wins — a duplicate id in a
 * later root is skipped.
 */
export async function discoverPackages(rootDirs: string[]): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];
  const seenIds = new Set<string>();

  for (const root of rootDirs) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue; // missing/unreadable root: treated as empty
    }

    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        const loaded = await loadExperience(dir);
        if (seenIds.has(loaded.experience.id)) continue;
        seenIds.add(loaded.experience.id);
        packages.push(toPackageInfo(loaded, dir));
      } catch {
        continue; // not a valid package: skipped, never fails the listing
      }
    }
  }

  return packages;
}

/**
 * Rejects zip entry names that could escape the extraction directory —
 * absolute paths, drive letters, backslash separators, or any ".."
 * segment. Returns the normalized relative path to extract to.
 */
function safeEntryPath(entryName: string): string {
  if (entryName.includes("\\")) {
    throw new Error(`Zip entry "${entryName}" uses backslash separators`);
  }
  const normalized = normalize(entryName);
  if (normalized.startsWith(sep) || /^[A-Za-z]:/.test(normalized) || normalized.split(sep).includes("..")) {
    throw new Error(`Zip entry "${entryName}" escapes the extraction directory`);
  }
  return normalized;
}

/** Promise wrapper over yauzl's callback API, extracting every file entry under destDir with traversal/entry-count/total-size guards. */
function extractZip(zipBuffer: Buffer, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error("Failed to open zip"));
        return;
      }

      let entryCount = 0;
      let totalBytes = 0;

      zipFile.on("error", reject);
      zipFile.on("end", () => resolve());
      zipFile.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          entryCount += 1;
          if (entryCount > MAX_ZIP_ENTRIES) {
            throw new Error(`Zip has too many entries (limit ${MAX_ZIP_ENTRIES})`);
          }

          const relativePath = safeEntryPath(entry.fileName);
          if (entry.fileName.endsWith("/")) {
            await mkdir(join(destDir, relativePath), { recursive: true });
            zipFile.readEntry();
            return;
          }

          totalBytes += entry.uncompressedSize;
          if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
            throw new Error(`Zip uncompressed size exceeds limit (${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)`);
          }

          const destPath = join(destDir, relativePath);
          await mkdir(join(destPath, ".."), { recursive: true });
          await new Promise<void>((resolveEntry, rejectEntry) => {
            zipFile.openReadStream(entry, (streamError, readStream) => {
              if (streamError || !readStream) {
                rejectEntry(streamError ?? new Error("Failed to read zip entry"));
                return;
              }
              pipeline(readStream, createWriteStream(destPath)).then(resolveEntry, rejectEntry);
            });
          });
          zipFile.readEntry();
        })().catch((error: unknown) => {
          zipFile.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });

      zipFile.readEntry();
    });
  });
}

/**
 * Finds the directory that actually contains experience.json inside an
 * extracted zip — supporting both layouts package authors plausibly
 * produce: files at the archive root, or everything under one top-level
 * folder (what zipping a directory usually yields).
 */
async function findPackageRoot(extractedDir: string): Promise<string> {
  const entries = await readdir(extractedDir);
  if (entries.includes("experience.json")) {
    return extractedDir;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if ((await stat(join(extractedDir, entry))).isDirectory()) {
      subdirs.push(entry);
    }
  }
  if (subdirs.length === 1) {
    const nested = join(extractedDir, subdirs[0]);
    const nestedEntries = await readdir(nested);
    if (nestedEntries.includes("experience.json")) {
      return nested;
    }
  }
  throw new Error("Zip does not contain an experience.json at its root (or under a single top-level folder)");
}

/**
 * Imports a zipped Experience package: extracts to a temp directory
 * (guarded — see extractZip/safeEntryPath), validates the whole package
 * by actually loading it (the same loadExperience used at runtime, so an
 * import that succeeds is guaranteed selectable), strips any runtime
 * dtm.sqlite the author accidentally zipped up (session state never
 * ships with content), then installs it at `<destRoot>/<experienceId>`.
 * Rejects if a package with the same id is already installed there —
 * imports never silently overwrite.
 */
export async function importPackageZip(zipBuffer: Buffer, destRoot: string): Promise<PackageInfo> {
  const tempDir = await mkdtemp(join(tmpdir(), "genesis-package-"));
  try {
    await extractZip(zipBuffer, tempDir);
    const packageRoot = await findPackageRoot(tempDir);

    await rm(join(packageRoot, "dtm.sqlite"), { force: true });

    const loaded = await loadExperience(packageRoot);

    const destDir = join(destRoot, loaded.experience.id);
    let destExists = true;
    try {
      await stat(destDir);
    } catch {
      destExists = false;
    }
    if (destExists) {
      throw new Error(`A package with id "${loaded.experience.id}" is already installed`);
    }

    await mkdir(destRoot, { recursive: true });
    await rename(packageRoot, destDir);

    return toPackageInfo(loaded, destDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Fields a player supplies to build a custom character; `abilities`/`skills` are id -> allocated-value maps, unsupplied ids default to the pool's floor. */
export interface CreateCharacterInput {
  name: string;
  class?: string;
  race?: string;
  background?: string;
  personality?: string;
  tone?: string;
  abilities?: Record<string, number>;
  skills?: Record<string, number>;
}

/**
 * Resolves a player's point-buy allocation against one pool and one
 * ruleset definition list (abilities or skills): every declared id not
 * present in `allocated` defaults to `pointBuy.floor`; every present
 * value must fall within `[floor, cap]`; the total spent above floor
 * across every id must not exceed `pointBuy.pool`. Throws on the first
 * violation found — this is the authoritative (server-side) check, a
 * client-side estimate is only ever advisory.
 */
function resolvePointBuyAllocation(
  pointBuy: PointBuy,
  defs: { id: string }[],
  allocated: Record<string, number> | undefined,
  kind: "ability" | "skill",
): Map<string, number> {
  const defIds = new Set(defs.map((def) => def.id));
  for (const id of Object.keys(allocated ?? {})) {
    if (!defIds.has(id)) {
      throw new Error(`Unknown ${kind} id "${id}"`);
    }
  }

  const resolved = new Map<string, number>();
  let spent = 0;
  for (const def of defs) {
    const value = allocated?.[def.id] ?? pointBuy.floor;
    if (value < pointBuy.floor || value > pointBuy.cap) {
      throw new Error(`${kind} "${def.id}" must be between ${pointBuy.floor} and ${pointBuy.cap} (got ${value})`);
    }
    spent += value - pointBuy.floor;
    resolved.set(def.id, value);
  }
  if (spent > pointBuy.pool) {
    throw new Error(`${kind} allocation spends ${spent} points, but only ${pointBuy.pool} are available`);
  }
  return resolved;
}

/** Turns a player-chosen name into a filesystem/dtm-safe character id, de-duplicated against ids already in this package. */
function generateCharacterId(name: string, existingIds: Set<string>): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "character";
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Builds and persists a player-authored character for an Experience that
 * opts in via `customCharacter` (ExperienceSchema) — the only path
 * abilities/skills take is point-buy against this Experience's own
 * resolved ruleset (loaded.ruleset.abilities/skills), never free-form
 * values. Writes two files: the new `characters/<id>.json` sheet, and an
 * appended `{characterId, startingNodeId}` entry in `experience.json`'s
 * own `characters` placement array — required because state/'s getState
 * throws for any loaded character sheet missing a placement entry, so a
 * sheet without one would break every subsequent turn/scope read for
 * this Experience, not just fail to load.
 *
 * `experience.json` is read and rewritten as raw JSON, not as the
 * Zod-parsed `Experience` object, so any field this schema doesn't know
 * about is preserved rather than silently dropped on rewrite.
 */
export async function createCustomCharacter(
  packageDir: string,
  loaded: LoadedExperience,
  input: CreateCharacterInput,
): Promise<{ id: string; name: string }> {
  const config = loaded.experience.customCharacter;
  if (!config) {
    throw new Error(`Experience "${loaded.experience.id}" does not allow custom characters`);
  }
  if (input.name.trim() === "") {
    throw new Error("A custom character needs a name");
  }

  const abilityValues = resolvePointBuyAllocation(config.abilityPointBuy, loaded.ruleset.abilities, input.abilities, "ability");
  const skillValues = resolvePointBuyAllocation(config.skillPointBuy, loaded.ruleset.skills, input.skills, "skill");

  const id = generateCharacterId(input.name, new Set(loaded.characters.map((c) => c.id)));
  const sheet: CharacterSheet = CharacterSheetSchema.parse({
    id,
    name: input.name.trim(),
    class: input.class,
    race: input.race,
    background: input.background,
    personality: input.personality,
    tone: input.tone,
    abilities: loaded.ruleset.abilities.map((def) => ({
      id: def.id,
      name: def.name,
      score: abilityValues.get(def.id)!,
    })),
    skills: loaded.ruleset.skills.map((def) => ({
      id: def.id,
      name: def.name,
      governingAbilityId: def.governingAbilityId,
      value: skillValues.get(def.id)!,
    })),
    techniques: [],
    inventory: [],
    hitPoints: { current: config.hitPoints.max, max: config.hitPoints.max },
    armorClass: config.armorClass,
  });

  await writeFile(join(packageDir, "characters", `${id}.json`), JSON.stringify(sheet, null, 2));

  const experienceJsonPath = join(packageDir, "experience.json");
  const rawExperience = JSON.parse(await readFile(experienceJsonPath, "utf-8")) as { characters?: unknown[] };
  rawExperience.characters = [...(rawExperience.characters ?? []), { characterId: id, startingNodeId: config.startingNodeId }];
  await writeFile(experienceJsonPath, JSON.stringify(rawExperience, null, 2));

  return { id, name: sheet.name };
}
