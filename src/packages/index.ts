import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { loadExperience } from "../data/loaders/experience.js";
import type { ExperienceMode } from "../data/schemas/experience.js";

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
        packages.push({
          id: loaded.experience.id,
          name: loaded.experience.name,
          version: loaded.experience.version,
          description: loaded.experience.description,
          author: loaded.experience.author,
          mode: loaded.mode,
          dir,
        });
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

    return {
      id: loaded.experience.id,
      name: loaded.experience.name,
      version: loaded.experience.version,
      description: loaded.experience.description,
      author: loaded.experience.author,
      mode: loaded.mode,
      dir: destDir,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
