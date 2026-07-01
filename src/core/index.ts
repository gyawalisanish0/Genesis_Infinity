import { loadExperience, type LoadedExperience } from "../data/loaders/experience.js";
import { Dtm } from "../dtm/index.js";
import { createAiSession, type ToolCallRecord } from "../ai/index.js";
import type { ToolContext } from "../tools/index.js";

export interface EngineOptions {
  experienceDir: string;
  dbPath: string;
  modelPath: string;
  /** Called after each tool call resolves — used by io/'s debug-dump mode. */
  onToolCall?: (call: ToolCallRecord) => void;
}

export interface Engine {
  loaded: LoadedExperience;
  toolCtx: ToolContext;
  /** The engine's current turn counter (see dtm/'s "engine time"). */
  currentTurn(): number;
  /** Sends one user turn through the agentic loop, advancing engine time by one. */
  takeTurn(input: string): Promise<string>;
  dispose(): Promise<void>;
}

function buildSystemPrompt(loaded: LoadedExperience): string {
  const characterNames = loaded.characters.map((c) => c.name).join(", ");
  return [
    `You are the narrator and game master for "${loaded.experience.name}", set in "${loaded.world.name}".`,
    `Characters in this Experience: ${characterNames}.`,
    "Use the available tools to check the game state before narrating or acting.",
    "Never describe a change to the world without making it happen through a tool call first.",
  ].join("\n");
}

/**
 * Assembles a playable Experience: loads its data, opens dtm/, starts the
 * agentic loop (ai/), and exposes a single takeTurn entry point that
 * drives the check -> act -> narrate cycle for io/ to call per user turn.
 */
export async function createEngine(options: EngineOptions): Promise<Engine> {
  const loaded = await loadExperience(options.experienceDir);
  const dtm = new Dtm(options.dbPath);
  const toolCtx: ToolContext = { dtm, world: loaded.world, loaded };

  const aiSession = await createAiSession({
    modelPath: options.modelPath,
    toolCtx,
    systemPrompt: buildSystemPrompt(loaded),
    onToolCall: options.onToolCall,
  });

  let timestamp = 0;

  return {
    loaded,
    toolCtx,
    currentTurn: () => timestamp,
    async takeTurn(input: string) {
      timestamp += 1;
      return aiSession.prompt(input, timestamp);
    },
    async dispose() {
      await aiSession.dispose();
      dtm.close();
    },
  };
}
