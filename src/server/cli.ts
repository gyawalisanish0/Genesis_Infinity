#!/usr/bin/env node
import { startServer } from "./index.js";
import type { BackendConfig } from "../ai/index.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable "${name}" is required.`);
  }
  return value;
}

/**
 * Entry point for the always-on API server deployment (see
 * deploy/hf-space-server/). Configured entirely by environment variables
 * rather than CLI flags, since it's meant to run unattended in a
 * container. Defaults to the api backend (not llamaCpp) since this
 * deployment is meant to be a lightweight, always-listening process, not
 * one carrying a multi-GB local model.
 */
async function main(): Promise<void> {
  const experienceDir = process.env.EXPERIENCE_DIR ?? "examples/goku-vs-venom";
  const characterId = process.env.CHARACTER_ID ?? "goku";
  const port = Number(process.env.PORT ?? 7860);
  const corsOrigin = process.env.CORS_ORIGIN ?? "*";
  const apiKey = process.env.SERVER_API_KEY;

  if (!apiKey) {
    console.warn(
      "[server] WARNING: SERVER_API_KEY is not set — /api/turn and /api/scope are unauthenticated. " +
        "Anyone with this URL can drive turns on your model quota.",
    );
  }

  const backendType = process.env.BACKEND ?? "api";
  let backend: BackendConfig;
  if (backendType === "llamaCpp") {
    backend = { type: "llamaCpp", modelPath: requireEnv("MODEL_PATH") };
  } else {
    backend = {
      type: "api",
      baseURL: requireEnv("API_BASE_URL"),
      apiKey: requireEnv("API_KEY"),
      model: requireEnv("API_MODEL"),
    };
  }

  await startServer({
    experienceDir,
    dbPath: `${experienceDir}/dtm.sqlite`,
    backend,
    characterId,
    port,
    apiKey,
    corsOrigin,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
