#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createEngine } from "../core/index.js";
import { getState } from "../state/index.js";
import { getScope } from "../scope/index.js";
import type { ToolContext } from "../tools/index.js";
import type { ToolCallRecord } from "../ai/index.js";

interface Args {
  experienceDir: string;
  modelPath: string;
  characterId: string;
  dbPath: string;
  debug: boolean;
}

const USAGE =
  "Usage: npm run play -- --experience <dir> --model <path-to-gguf> --character <id> [--db <path>] [--debug]";

function parseArgs(argv: string[]): Args {
  const args: { experienceDir?: string; modelPath?: string; characterId?: string; dbPath?: string; debug: boolean } = {
    debug: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--experience":
        args.experienceDir = argv[++i];
        break;
      case "--model":
        args.modelPath = argv[++i];
        break;
      case "--character":
        args.characterId = argv[++i];
        break;
      case "--db":
        args.dbPath = argv[++i];
        break;
      case "--debug":
        args.debug = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}".\n${USAGE}`);
    }
  }

  if (!args.experienceDir || !args.modelPath || !args.characterId) {
    throw new Error(USAGE);
  }

  return {
    experienceDir: args.experienceDir,
    modelPath: args.modelPath,
    characterId: args.characterId,
    dbPath: args.dbPath ?? `${args.experienceDir}/dtm.sqlite`,
    debug: args.debug,
  };
}

function printScope(
  label: string,
  toolCtx: ToolContext,
  characterId: string,
  currentTurn: number,
): void {
  const state = getState(toolCtx.dtm, toolCtx.loaded, currentTurn);
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
    modelPath: args.modelPath,
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
