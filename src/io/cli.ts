#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createEngine } from "../core/index.js";
import { getState } from "../state/index.js";
import { getScope } from "../scope/index.js";
import type { ToolContext } from "../tools/index.js";
import type { BackendConfig, ToolCallRecord } from "../ai/index.js";

interface Args {
  experienceDir: string;
  characterId: string;
  dbPath: string;
  debug: boolean;
  backend: BackendConfig;
}

const USAGE = [
  "Usage:",
  "  npm run play -- --experience <dir> --model <path-to-gguf> --character <id> [--db <path>] [--debug]",
  "  npm run play -- --experience <dir> --backend api --api-base-url <url> " +
    "--api-model <model-id> --api-key-env <ENV_VAR_NAME> --character <id> [--db <path>] [--debug]",
  "",
  "  --api-base-url examples: https://router.huggingface.co/v1 (Hugging Face Inference Providers), " +
    "https://openrouter.ai/api/v1 (OpenRouter)",
  "  --api-key-env names an environment variable holding the API key - the key itself is never passed as a CLI argument.",
].join("\n");

function parseArgs(argv: string[]): Args {
  const raw: {
    experienceDir?: string;
    modelPath?: string;
    characterId?: string;
    dbPath?: string;
    debug: boolean;
    backendType: "llamaCpp" | "api";
    apiBaseUrl?: string;
    apiModel?: string;
    apiKeyEnv?: string;
  } = { debug: false, backendType: "llamaCpp" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--experience":
        raw.experienceDir = argv[++i];
        break;
      case "--model":
        raw.modelPath = argv[++i];
        break;
      case "--character":
        raw.characterId = argv[++i];
        break;
      case "--db":
        raw.dbPath = argv[++i];
        break;
      case "--debug":
        raw.debug = true;
        break;
      case "--backend": {
        const value = argv[++i];
        if (value !== "llamaCpp" && value !== "api") {
          throw new Error(`--backend must be "llamaCpp" or "api", got "${value}".\n${USAGE}`);
        }
        raw.backendType = value;
        break;
      }
      case "--api-base-url":
        raw.apiBaseUrl = argv[++i];
        break;
      case "--api-model":
        raw.apiModel = argv[++i];
        break;
      case "--api-key-env":
        raw.apiKeyEnv = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument "${arg}".\n${USAGE}`);
    }
  }

  if (!raw.experienceDir || !raw.characterId) {
    throw new Error(USAGE);
  }

  let backend: BackendConfig;
  if (raw.backendType === "llamaCpp") {
    if (!raw.modelPath) {
      throw new Error(`--model is required for --backend llamaCpp.\n${USAGE}`);
    }
    backend = { type: "llamaCpp", modelPath: raw.modelPath };
  } else {
    if (!raw.apiBaseUrl || !raw.apiModel || !raw.apiKeyEnv) {
      throw new Error(
        `--api-base-url, --api-model, and --api-key-env are all required for --backend api.\n${USAGE}`,
      );
    }
    const apiKey = process.env[raw.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Environment variable "${raw.apiKeyEnv}" is not set (expected to hold the API key).`);
    }
    backend = { type: "api", baseURL: raw.apiBaseUrl, apiKey, model: raw.apiModel };
  }

  return {
    experienceDir: raw.experienceDir,
    characterId: raw.characterId,
    dbPath: raw.dbPath ?? `${raw.experienceDir}/dtm.sqlite`,
    debug: raw.debug,
    backend,
  };
}

function printScope(
  label: string,
  toolCtx: ToolContext,
  characterId: string,
  currentTurn: number,
): void {
  const state = getState(
    toolCtx.dtm,
    toolCtx.loaded,
    toolCtx.world,
    currentTurn,
    toolCtx.timeline.currentUnit(),
  );
  const scope = getScope(toolCtx.world, state, characterId);
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(scope, null, 2));
}

function printToolCalls(calls: ToolCallRecord[]): void {
  console.log("\n--- tool calls ---");
  if (calls.length === 0) {
    console.log("(none)");
    return;
  }
  for (const call of calls) {
    console.log(`${call.name}(${JSON.stringify(call.params)}) -> ${JSON.stringify(call.result)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const toolCalls: ToolCallRecord[] = [];

  const engine = await createEngine({
    experienceDir: args.experienceDir,
    dbPath: args.dbPath,
    backend: args.backend,
    playerCharacterId: args.characterId,
    onToolCall: args.debug ? (call) => toolCalls.push(call) : undefined,
  });

  console.log(`Loaded "${engine.loaded.experience.name}". Type your input, or "exit" to quit.`);

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    for (;;) {
      const input = await rl.question("> ");
      if (input.trim().toLowerCase() === "exit") break;

      if (args.debug) {
        printScope("scope before turn", engine.toolCtx, args.characterId, engine.currentTurn());
      }

      toolCalls.length = 0;
      const response = await engine.takeTurn(input);

      if (args.debug) {
        printToolCalls(toolCalls);
        printScope("scope after turn", engine.toolCtx, args.characterId, engine.currentTurn());
      }

      console.log(`\n${response}\n`);
    }
  } finally {
    rl.close();
    await engine.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
