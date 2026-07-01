import { z } from "zod";

/**
 * Shared 2D coordinate, used both for a region's position on the world grid
 * and a node's position within a region's local (unbounded) sub-grid.
 */
export const PositionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});
export type Position = z.infer<typeof PositionSchema>;

export const WorldTypeSchema = z.enum(["narrative-bound", "semi-open", "open"]);
export type WorldType = z.infer<typeof WorldTypeSchema>;

/**
 * A single environmental condition (climate, hazard, lighting, etc).
 * `category` is an open string, not a fixed enum — categories vary by
 * setting (sci-fi radiation vs. fantasy curse vs. mundane weather).
 *
 * `mechanical` flags whether this code has a gameplay effect. When true,
 * `effectId` references an effect that rules/ resolves — the effect's
 * actual logic lives in rules/, not here, keeping world data decoupled
 * from rule implementation.
 *
 * A node's environmentalCodes merge with its region's, keyed by
 * (category, value): a node entry overrides the region's matching entry;
 * anything not declared on the node inherits from the region unchanged.
 */
export const EnvironmentalCodeSchema = z
  .object({
    category: z.string(),
    value: z.string(),
    severity: z.number().min(1).max(5),
    mechanical: z.boolean(),
    effectId: z.string().optional(),
    description: z.string().optional(),
  })
  .refine((code) => !code.mechanical || code.effectId !== undefined, {
    message: "effectId is required when mechanical is true",
    path: ["effectId"],
  });
export type EnvironmentalCode = z.infer<typeof EnvironmentalCodeSchema>;

export const EnvironmentalCodesSchema = z.array(EnvironmentalCodeSchema);

/**
 * A connection from one node to another. `direction` is only an override —
 * by default direction is computed by scope/ from node world-space
 * positions. Set it explicitly for non-geometric links (e.g. a portal)
 * where computed direction wouldn't make narrative sense.
 */
export const EdgeSchema = z.object({
  targetNodeId: z.string(),
  direction: z.string().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

/**
 * A single visitable location, nested inside a region. `layer` disambiguates
 * multiple nodes that share the same localPosition (e.g. surface vs.
 * basement). `localPosition` is unbounded — no declared sub-grid size.
 */
export const NodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  layer: z.number().int().optional(),
  localPosition: PositionSchema,
  environmentalCodes: EnvironmentalCodesSchema.optional(),
  connections: z.array(EdgeSchema).default([]),
});
export type Node = z.infer<typeof NodeSchema>;

/**
 * A grid cell on the world map. Regions are the macro unit of travel;
 * nodes are the actual places nested within a region.
 */
export const RegionSchema = z.object({
  id: z.string(),
  position: PositionSchema,
  name: z.string(),
  description: z.string().optional(),
  environmentalCodes: EnvironmentalCodesSchema.optional(),
  worldType: WorldTypeSchema,
  nodes: z.array(NodeSchema).default([]),
});
export type Region = z.infer<typeof RegionSchema>;

export const WorldSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    regions: z.array(RegionSchema).default([]),
  })
  .superRefine((world, ctx) => {
    const regionIds = new Set<string>();
    const nodeIds = new Set<string>();

    for (const region of world.regions) {
      if (region.position.x < 0 || region.position.x >= world.width ||
          region.position.y < 0 || region.position.y >= world.height) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Region "${region.id}" position is outside world bounds (${world.width}x${world.height})`,
        });
      }

      if (regionIds.has(region.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate region id "${region.id}"`,
        });
      }
      regionIds.add(region.id);

      for (const node of region.nodes) {
        if (nodeIds.has(node.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate node id "${node.id}" (node ids must be unique across the whole world, since edges can cross regions)`,
          });
        }
        nodeIds.add(node.id);
      }
    }

    for (const region of world.regions) {
      for (const node of region.nodes) {
        for (const edge of node.connections) {
          if (!nodeIds.has(edge.targetNodeId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Node "${node.id}" has an edge to unknown node "${edge.targetNodeId}"`,
            });
          }
        }
      }
    }
  });
export type World = z.infer<typeof WorldSchema>;

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
 * Merges a node's environmental codes over its region's, keyed by
 * (category, value) — a node entry overrides the region's matching entry.
 * Lives here (not scope/) rather than only computing a per-turn AI payload,
 * so state/ can also resolve a node's environmental codes without
 * depending on scope/ (which itself depends on state/'s types).
 */
export function mergeEnvironmentalCodes(region: Region, node: Node): EnvironmentalCode[] {
  const merged = new Map<string, EnvironmentalCode>();
  for (const code of region.environmentalCodes ?? []) {
    merged.set(`${code.category}:${code.value}`, code);
  }
  for (const code of node.environmentalCodes ?? []) {
    merged.set(`${code.category}:${code.value}`, code);
  }
  return [...merged.values()];
}
