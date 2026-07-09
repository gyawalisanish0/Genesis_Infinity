#!/usr/bin/env node
import { startServer } from "./index.js";
import { KNOWN_API_PROVIDERS, type ApiProviderId, type ConfiguredApiProvider } from "./apiProviders.js";

/**
 * Entry point for the always-on API server deployment (see
 * deploy/hf-space-server/). Configured entirely by environment variables
 * rather than CLI flags, since it's meant to run unattended in a
 * container. The server boots with no model loaded — the frontend picks
 * a backend/model at runtime via POST /api/backend (see server/index.ts,
 * server/modelCatalogue.ts) — so BACKEND/MODEL_PATH/API_MODEL are no
 * longer read here. Each known API provider (apiProviders.ts) has its own
 * API-key env var; a provider with no key set is simply unavailable to
 * the frontend's "api" backend picker. The frontend only ever supplies a
 * provider id + model string, never a credential.
 *
 * DEBUG=true (or "1") turns on server/index.ts's per-turn console logging
 * (input, each tool call, final narration) — the server-side equivalent of
 * io/cli.ts's --debug flag, visible in a deployed Space's container logs.
 */
async function main(): Promise<void> {
  const experienceDir = process.env.EXPERIENCE_DIR ?? "examples/blackline-action";
  const characterId = process.env.CHARACTER_ID ?? "kestrel";
  const port = Number(process.env.PORT ?? 7860);
  const corsOrigin = process.env.CORS_ORIGIN ?? "*";
  const apiKey = process.env.SERVER_API_KEY;
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";

  if (!apiKey) {
    console.warn(
      "[server] WARNING: SERVER_API_KEY is not set — /api/turn and /api/scope are unauthenticated. " +
        "Anyone with this URL can drive turns on your model quota.",
    );
  }

  const apiProviders: Partial<Record<ApiProviderId, ConfiguredApiProvider>> = {};
  for (const id of Object.keys(KNOWN_API_PROVIDERS) as ApiProviderId[]) {
    const providerKey = process.env[KNOWN_API_PROVIDERS[id].envVar];
    if (providerKey) apiProviders[id] = { baseURL: KNOWN_API_PROVIDERS[id].baseURL, apiKey: providerKey };
  }
  if (Object.keys(apiProviders).length === 0) {
    const envVars = Object.values(KNOWN_API_PROVIDERS)
      .map((p) => p.envVar)
      .join(", ");
    console.warn(
      `[server] No API provider keys set (${envVars}) — the frontend's "api" backend tab will show no ` +
        "providers (local GGUF models via the frontend's picker still work).",
    );
  }

  await startServer({
    experienceDir,
    dbPath: `${experienceDir}/dtm.json`,
    characterId,
    port,
    apiKey,
    corsOrigin,
    apiProviders,
    modelsDir: process.env.MODELS_DIR ?? "models",
    experiencesDir: process.env.EXPERIENCES_DIR ?? "experiences",
    debug,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
