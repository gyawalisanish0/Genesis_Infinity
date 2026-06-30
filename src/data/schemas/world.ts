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
 * Environmental codes are a placeholder until the engine-wide schema is
 * defined (see docs/ARCHITECTURE.md, Open / Deferred).
 */
export const EnvironmentalCodesSchema = z.array(z.string());

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
