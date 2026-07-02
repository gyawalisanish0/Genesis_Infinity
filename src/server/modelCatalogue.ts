import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

/**
 * Safety cap on a single GGUF download triggered from the frontend's model
 * picker — this is a public-facing server with limited disk, not a dev
 * sandbox, so an unbounded download isn't acceptable even though the
 * source (Hugging Face's own catalogue) is trusted.
 */
const MAX_MODEL_BYTES = 6 * 1024 * 1024 * 1024;

export interface ModelSearchResult {
  id: string;
  downloads: number;
  likes: number;
}

/** Searches Hugging Face Hub's public model catalogue, filtered to GGUF-tagged repos. */
export async function searchGgufModels(query: string): Promise<ModelSearchResult[]> {
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=10`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hugging Face model search failed (HTTP ${response.status})`);
  }
  const data = (await response.json()) as Array<{ id: string; downloads?: number; likes?: number }>;
  return data.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0 }));
}

/** Lists the .gguf files available in a given Hub repo. */
export async function listGgufFiles(repoId: string): Promise<string[]> {
  const response = await fetch(`https://huggingface.co/api/models/${repoId}`);
  if (!response.ok) {
    throw new Error(`Could not read repo "${repoId}" (HTTP ${response.status})`);
  }
  const data = (await response.json()) as { siblings?: Array<{ rfilename: string }> };
  return (data.siblings ?? []).map((sibling) => sibling.rfilename).filter((name) => name.endsWith(".gguf"));
}

/**
 * Downloads a single GGUF file from a Hub repo into modelsDir. Enforces
 * MAX_MODEL_BYTES and a single-cached-model policy — any previously
 * downloaded .gguf files in modelsDir are removed first — so repeated
 * experimentation from the frontend's model picker can't accumulate
 * unbounded disk usage on the server.
 */
export async function downloadGgufModel(repoId: string, filename: string, modelsDir: string): Promise<string> {
  if (!filename.endsWith(".gguf")) {
    throw new Error(`"${filename}" is not a .gguf file`);
  }

  const url = `https://huggingface.co/${repoId}/resolve/main/${filename}`;
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) {
    throw new Error(`Could not find "${filename}" in "${repoId}" (HTTP ${head.status})`);
  }
  const size = Number(head.headers.get("content-length") ?? "0");
  if (size > MAX_MODEL_BYTES) {
    throw new Error(
      `"${filename}" is ${(size / 1e9).toFixed(1)}GB, over the ${(MAX_MODEL_BYTES / 1e9).toFixed(0)}GB safety cap`,
    );
  }

  await mkdir(modelsDir, { recursive: true });
  const existing = await readdir(modelsDir).catch(() => [] as string[]);
  await Promise.all(
    existing.filter((name) => name.endsWith(".gguf")).map((name) => rm(path.join(modelsDir, name)).catch(() => {})),
  );

  const destPath = path.join(modelsDir, filename.replace(/[^a-zA-Z0-9._-]/g, "_"));
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download of "${filename}" failed (HTTP ${response.status})`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
  return destPath;
}
