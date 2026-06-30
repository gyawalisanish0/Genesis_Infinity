import type { Dtm, DtmEvent } from "../dtm/index.js";
import type { World } from "../data/schemas/world.js";
import type { LoadedExperience } from "../data/loaders/experience.js";
import type { CharacterSheet } from "../data/schemas/character.js";
import { getState } from "../state/index.js";
import { getScope, findNode, type Scope } from "../scope/index.js";

/**
 * Everything a tool handler needs to read engine state. Bound once per
 * session (a single Experience/playthrough) by whoever wires these into
 * the agentic loop — see ai/.
 */
export interface ToolContext {
  dtm: Dtm;
  world: World;
  loaded: LoadedExperience;
}

export interface MoveResult {
  success: boolean;
  reason?: string;
  nodeId?: string;
}

/** Check tool: the AI-visible scope (location, environment, connections, who's present) for a character. */
export function getScopeTool(ctx: ToolContext, params: { characterId: string }): Scope {
  const state = getState(ctx.dtm, ctx.loaded);
  return getScope(ctx.world, state, params.characterId);
}

/** Check tool: a character's static sheet (identity, abilities, skills). */
export function getCharacterSheetTool(
  ctx: ToolContext,
  params: { characterId: string },
): CharacterSheet {
  const sheet = ctx.loaded.characters.find((c) => c.id === params.characterId);
  if (!sheet) {
    throw new Error(`Character "${params.characterId}" not found`);
  }
  return sheet;
}

/** Check tool: the most recent dtm events for this Experience. */
export function getRecentDtmTool(ctx: ToolContext, params: { limit: number }): DtmEvent[] {
  return ctx.dtm.recent(ctx.loaded.experience.id, params.limit);
}

/**
 * Action tool: moves a character to a target node, recording an
 * "entity.moved" dtm event. Only checks that the target is reachable via an
 * edge from the character's current node — mechanical/narrative legality
 * beyond that is rules/'s job, applied by whoever wires this tool into the
 * agentic loop before calling it (see ai/, docs/ARCHITECTURE.md Turn Flow).
 */
export function moveTool(
  ctx: ToolContext,
  params: { characterId: string; targetNodeId: string; timestamp: number },
): MoveResult {
  const state = getState(ctx.dtm, ctx.loaded);
  const character = state.characters.find((c) => c.sheet.id === params.characterId);
  if (!character) {
    return { success: false, reason: `Character "${params.characterId}" not found` };
  }

  const from = findNode(ctx.world, character.nodeId);
  const isConnected = from.node.connections.some(
    (edge) => edge.targetNodeId === params.targetNodeId,
  );
  if (!isConnected) {
    return {
      success: false,
      reason: `"${params.targetNodeId}" is not reachable from "${character.nodeId}"`,
    };
  }

  ctx.dtm.append({
    experienceId: ctx.loaded.experience.id,
    timestamp: params.timestamp,
    type: "entity.moved",
    entityId: params.characterId,
    nodeId: params.targetNodeId,
  });

  return { success: true, nodeId: params.targetNodeId };
}
