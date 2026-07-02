#!/usr/bin/env node
import { startServer } from "./index.js";

/**
 * Entry point for the always-on API server deployment (see
 * deploy/hf-space-server/). Configured entirely by environment variables
 * rather than CLI flags, since it's meant to run unattended in a
 * container. The server boots with no model loaded — the frontend picks
 * a backend/model at runtime via POST /api/backend (see server/index.ts,
 * server/modelCatalogue.ts) — so BACKEND/MODEL_PATH/API_MODEL are no
 * longer read here. API_BASE_URL/API_KEY, if both set, become the
 * server-side-only credentials the frontend's "api" backend choice uses;
 * the frontend only ever supplies a model id, never the credential.
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

  const apiBaseUrl = process.env.API_BASE_URL;
  const apiCredential = process.env.API_KEY;
  const apiBackendDefaults =
    apiBaseUrl && apiCredential ? { baseURL: apiBaseUrl, apiKey: apiCredential } : undefined;
  if (!apiBackendDefaults) {
    console.warn(
      "[server] API_BASE_URL/API_KEY not set — the frontend's \"api\" backend option won't be available " +
        "until they're configured (local GGUF models via the frontend's picker still work).",
    );
  }

  await startServer({
    experienceDir,
    dbPath: `${experienceDir}/dtm.sqlite`,
    characterId,
    port,
    apiKey,
    corsOrigin,
    apiBackendDefaults,
    modelsDir: process.env.MODELS_DIR ?? "models",
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
