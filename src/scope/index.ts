import type { World, Node, Region, EnvironmentalCode } from "../data/schemas/world.js";
import type { StateSnapshot, CharacterState } from "../state/index.js";

export interface ScopedConnection {
  targetNodeId: string;
  targetNodeName: string;
  direction: string;
}

export interface ScopedNode {
  id: string;
  name: string;
  description: string;
  type: string;
  environmentalCodes: EnvironmentalCode[];
  connections: ScopedConnection[];
}

export interface ScopedCharacter {
  id: string;
  name: string;
}

export interface Scope {
  character: CharacterState["sheet"];
  node: ScopedNode;
  othersPresent: ScopedCharacter[];
}

/** Merges a node's environmental codes over its region's, keyed by (category, value). */
function mergeEnvironmentalCodes(region: Region, node: Node): EnvironmentalCode[] {
  const merged = new Map<string, EnvironmentalCode>();
  for (const code of region.environmentalCodes ?? []) {
    merged.set(`${code.category}:${code.value}`, code);
  }
  for (const code of node.environmentalCodes ?? []) {
    merged.set(`${code.category}:${code.value}`, code);
  }
  return [...merged.values()];
}

// 8-point compass from a delta. +x = east, +y = north.
function compassDirection(dx: number, dy: number): string {
  const ns = dy > 0 ? "north" : dy < 0 ? "south" : "";
  const ew = dx > 0 ? "east" : dx < 0 ? "west" : "";
  return ns + ew || "here";
}

function layerDirection(fromLayer: number | undefined, toLayer: number | undefined): string {
  const from = fromLayer ?? 0;
  const to = toLayer ?? 0;
  if (to > from) return "up";
  if (to < from) return "down";
  return "here";
}

export interface NodeLocation {
  region: Region;
  node: Node;
}

/** Finds a node and its parent region anywhere in the world, by node id. */
export function findNode(world: World, nodeId: string): NodeLocation {
  for (const region of world.regions) {
    const node = region.nodes.find((n) => n.id === nodeId);
    if (node) return { region, node };
  }
  throw new Error(`Node "${nodeId}" not found in world "${world.id}"`);
}

/**
 * Direction from one node to another. Same-region edges compare local
 * positions; cross-region edges compare region positions instead, since
 * local sub-grids are unbounded and not comparable across regions. Nodes
 * stacked at the same position (different layer) resolve to up/down.
 */
function directionBetween(from: NodeLocation, to: NodeLocation): string {
  if (from.region.id === to.region.id) {
    const dx = to.node.localPosition.x - from.node.localPosition.x;
    const dy = to.node.localPosition.y - from.node.localPosition.y;
    if (dx === 0 && dy === 0) {
      return layerDirection(from.node.layer, to.node.layer);
    }
    return compassDirection(dx, dy);
  }
  const dx = to.region.position.x - from.region.position.x;
  const dy = to.region.position.y - from.region.position.y;
  return compassDirection(dx, dy);
}

/**
 * Computes the AI-visible scope for a character this turn: their current
 * node (merged environmental codes, connections with computed direction),
 * and which other characters are present at the same node.
 */
export function getScope(world: World, state: StateSnapshot, characterId: string): Scope {
  const character = state.characters.find((c) => c.sheet.id === characterId);
  if (!character) {
    throw new Error(`Character "${characterId}" not found in state`);
  }

  const from = findNode(world, character.nodeId);

  const connections: ScopedConnection[] = from.node.connections.map((edge) => {
    const to = findNode(world, edge.targetNodeId);
    return {
      targetNodeId: edge.targetNodeId,
      targetNodeName: to.node.name,
      direction: edge.direction ?? directionBetween(from, to),
    };
  });

  const othersPresent: ScopedCharacter[] = state.characters
    .filter((c) => c.sheet.id !== characterId && c.nodeId === character.nodeId)
    .map((c) => ({ id: c.sheet.id, name: c.sheet.name }));

  return {
    character: character.sheet,
    node: {
      id: from.node.id,
      name: from.node.name,
      description: from.node.description,
      type: from.node.type,
      environmentalCodes: mergeEnvironmentalCodes(from.region, from.node),
      connections,
    },
    othersPresent,
  };
}
