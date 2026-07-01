import type { Dtm, DtmEvent } from "../dtm/index.js";
import type { World } from "../data/schemas/world.js";
import type { LoadedExperience } from "../data/loaders/experience.js";
import type { CharacterSheet, EffectDef } from "../data/schemas/character.js";
import { getState, type AppliedDebuff } from "../state/index.js";
import { getScope, findNode, type Scope } from "../scope/index.js";
import type { Timeline } from "../timeline/index.js";

/** Outcome of an action, as decided by rules/ (see rules/index.ts). */
export type ActionOutcome = "valid" | "neutral";

/**
 * Everything a tool handler needs to read engine state. Bound once per
 * session (a single Experience/playthrough) by whoever wires these into
 * the agentic loop — see ai/. `timeline` drives effect duration (see
 * rejectAction) — a real-wall-clock-anchored clock, independent of turn
 * count.
 */
export interface ToolContext {
  dtm: Dtm;
  world: World;
  loaded: LoadedExperience;
  timeline: Timeline;
}

/** A proposed action, as committed to by the AI this turn (see ai/). */
export type Action =
  | { type: "move"; characterId: string; targetNodeId: string; timestamp: number }
  | {
      type: "use_technique";
      characterId: string;
      techniqueId: string;
      targetId?: string;
      timestamp: number;
    }
  | {
      type: "interact";
      characterId: string;
      description: string;
      targetId?: string;
      timestamp: number;
    };

export interface ActionCheck {
  allowed: boolean;
  reason?: string;
}

export interface ActionResult {
  success: boolean;
  reason?: string;
  nodeId?: string;
  techniqueId?: string;
  outcome?: ActionOutcome;
}

export interface RejectionResult {
  success: false;
  reason: string;
  /** Total rejected actions this character has accrued (including this one). */
  strikeCount: number;
  /** Present once strikeCount reaches the Experience's escalation.strikeThreshold — the punishment applied this time. */
  debuffApplied?: AppliedDebuff;
}

/** Check tool: the AI-visible scope (location, environment, connections, who's present) for a character. */
export function getScopeTool(
  ctx: ToolContext,
  params: { characterId: string },
  currentTurn: number,
): Scope {
  const state = getState(ctx.dtm, ctx.loaded, currentTurn, ctx.timeline.currentUnit());
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

export interface SayResult {
  success: true;
  message: string;
}

/**
 * A character speaking — dialogue, taunts, questions, declarations. Always
 * permitted: no checkAction/rules/ gate and no escalation on repeat, since
 * speech has no capability or legality dimension the way move/use_technique
 * do. Still written to dtm/ so it's part of the persistent history (see
 * get_recent_dtm) — unlike the read-only check tools above, this is a write,
 * but one that (unlike `action`) never needs validation.
 */
export function sayTool(
  ctx: ToolContext,
  params: { characterId: string; message: string; targetId?: string },
  turnTimestamp: number,
): SayResult {
  ctx.dtm.append({
    experienceId: ctx.loaded.experience.id,
    timestamp: turnTimestamp,
    type: "character.said",
    entityId: params.characterId,
    payload: { message: params.message, targetId: params.targetId },
  });
  return { success: true, message: params.message };
}

function checkMove(
  ctx: ToolContext,
  action: Extract<Action, { type: "move" }>,
): ActionCheck {
  const state = getState(ctx.dtm, ctx.loaded, action.timestamp, ctx.timeline.currentUnit());
  const character = state.characters.find((c) => c.sheet.id === action.characterId);
  if (!character) {
    return { allowed: false, reason: `Character "${action.characterId}" not found` };
  }

  const from = findNode(ctx.world, character.nodeId);
  const isConnected = from.node.connections.some(
    (edge) => edge.targetNodeId === action.targetNodeId,
  );
  if (!isConnected) {
    return {
      allowed: false,
      reason: `"${action.targetNodeId}" is not reachable from "${character.nodeId}"`,
    };
  }

  return { allowed: true };
}

function applyMove(
  ctx: ToolContext,
  action: Extract<Action, { type: "move" }>,
  outcome: ActionOutcome,
): ActionResult {
  ctx.dtm.append({
    experienceId: ctx.loaded.experience.id,
    timestamp: action.timestamp,
    type: "entity.moved",
    entityId: action.characterId,
    nodeId: action.targetNodeId,
    payload: { outcome },
  });
  return { success: true, nodeId: action.targetNodeId, outcome };
}

/**
 * Hard capability gate: a character may only attempt a technique that
 * appears on their sheet. Checked structurally, before the attempt ever
 * reaches rules/ — this is not a model judgment call.
 */
function checkUseTechnique(
  ctx: ToolContext,
  action: Extract<Action, { type: "use_technique" }>,
): ActionCheck {
  const sheet = ctx.loaded.characters.find((c) => c.id === action.characterId);
  if (!sheet) {
    return { allowed: false, reason: `Character "${action.characterId}" not found` };
  }

  const knowsTechnique = sheet.techniques.some((t) => t.id === action.techniqueId);
  if (!knowsTechnique) {
    return {
      allowed: false,
      reason: `"${sheet.name}" does not know a technique called "${action.techniqueId}"`,
    };
  }

  return { allowed: true };
}

function applyUseTechnique(
  ctx: ToolContext,
  action: Extract<Action, { type: "use_technique" }>,
  outcome: ActionOutcome,
): ActionResult {
  ctx.dtm.append({
    experienceId: ctx.loaded.experience.id,
    timestamp: action.timestamp,
    type: "technique.used",
    entityId: action.characterId,
    payload: { techniqueId: action.techniqueId, targetId: action.targetId, outcome },
  });
  return { success: true, techniqueId: action.techniqueId, outcome };
}

/**
 * Structural gate for interact: no hard capability check is possible for
 * free-form content, but if a target is named it must actually be present
 * — same node as the acting character. This is the only deterministic
 * guardrail on interact; everything else (does the attempt succeed) is
 * rules/'s tri-state judgment (see docs/ARCHITECTURE.md).
 */
function checkInteract(
  ctx: ToolContext,
  action: Extract<Action, { type: "interact" }>,
): ActionCheck {
  if (!action.targetId) {
    return { allowed: true };
  }

  const state = getState(ctx.dtm, ctx.loaded, action.timestamp, ctx.timeline.currentUnit());
  const actor = state.characters.find((c) => c.sheet.id === action.characterId);
  if (!actor) {
    return { allowed: false, reason: `Character "${action.characterId}" not found` };
  }

  const target = state.characters.find((c) => c.sheet.id === action.targetId);
  if (!target) {
    return { allowed: false, reason: `"${action.targetId}" not found` };
  }

  if (target.nodeId !== actor.nodeId) {
    return {
      allowed: false,
      reason: `"${target.sheet.name}" is not present at "${actor.nodeId}"`,
    };
  }

  return { allowed: true };
}

function applyInteract(
  ctx: ToolContext,
  action: Extract<Action, { type: "interact" }>,
  outcome: ActionOutcome,
): ActionResult {
  ctx.dtm.append({
    experienceId: ctx.loaded.experience.id,
    timestamp: action.timestamp,
    type: "character.interacted",
    entityId: action.characterId,
    payload: { description: action.description, targetId: action.targetId, outcome },
  });
  return { success: true, outcome };
}

/**
 * Picks a random effect from the Experience's resolved effect pool, limited
 * to severities at or below `ceiling`. Falls back to the pool's lowest-
 * severity effect(s) if nothing qualifies (e.g. a custom pool with no
 * severity-1 entries) so escalation never has zero eligible effects.
 */
function pickEffect(effects: EffectDef[], ceiling: number): EffectDef {
  const eligible = effects.filter((effect) => effect.severity <= ceiling);
  const pool = eligible.length > 0 ? eligible : effects;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Records a rejected action attempt — from checkAction's hard capability
 * gate, or rules/'s "invalid" judgment — and escalates: once a character
 * accrues `ctx.loaded.escalation.strikeThreshold` rejections, this and every
 * further rejection also applies a random effect drawn from the
 * Experience's resolved effect pool (`ctx.loaded.ruleset.effects`),
 * expiring `escalation.debuffDurationUnits` timeline/ units later (real-
 * wall-clock-anchored — see timeline/index.ts — not turn count, so a
 * debuff's real-world duration doesn't depend on how many turns the player
 * takes). The eligible severity ceiling rises by 1 with each strike past
 * the threshold (capped at `escalation.maxSeverity`), so punishment trends
 * harsher the longer it's ignored without being fully deterministic. This
 * is deterministic bookkeeping, not a model judgment call. `turnTimestamp`
 * is only used for the dtm events' own `timestamp` column (turn count, for
 * ordering) — unrelated to the debuff's timeline-based expiry.
 */
export function rejectAction(
  ctx: ToolContext,
  characterId: string,
  actionType: string,
  reason: string,
  turnTimestamp: number,
): RejectionResult {
  const { strikeThreshold, maxSeverity, debuffDurationUnits } = ctx.loaded.escalation;

  ctx.dtm.append({
    experienceId: ctx.loaded.experience.id,
    timestamp: turnTimestamp,
    type: "action.rejected",
    entityId: characterId,
    payload: { actionType, reason },
  });

  const strikeCount = ctx.dtm
    .forEntity(ctx.loaded.experience.id, characterId)
    .filter((event) => event.type === "action.rejected").length;

  if (strikeCount < strikeThreshold) {
    return { success: false, reason, strikeCount };
  }

  const severityCeiling = Math.min(maxSeverity, strikeCount - strikeThreshold + 1);
  const template = pickEffect(ctx.loaded.ruleset.effects, severityCeiling);
  const appliedAtUnit = ctx.timeline.currentUnit();
  const debuffApplied: AppliedDebuff = {
    ...template,
    appliedAtUnit,
    expiresAtUnit: appliedAtUnit + debuffDurationUnits,
  };
  ctx.dtm.append({
    experienceId: ctx.loaded.experience.id,
    timestamp: turnTimestamp,
    type: "debuff.applied",
    entityId: characterId,
    payload: debuffApplied,
  });

  return { success: false, reason, strikeCount, debuffApplied };
}

/**
 * Structural/capability pre-check for a proposed action — reachability for
 * move, "does the character actually know this" for use_technique, "does
 * the named target exist and is it present" for interact. This is the hard
 * gate: failing it means the action never reaches rules/ at all (see ai/,
 * docs/ARCHITECTURE.md Turn Flow).
 */
export function checkAction(ctx: ToolContext, action: Action): ActionCheck {
  switch (action.type) {
    case "move":
      return checkMove(ctx, action);
    case "use_technique":
      return checkUseTechnique(ctx, action);
    case "interact":
      return checkInteract(ctx, action);
  }
}

/**
 * Applies an action that has already passed checkAction and rules/
 * validation — writes the resulting dtm event. `outcome` distinguishes a
 * full success ("valid") from a fizzle ("neutral") per rules/'s judgment.
 */
export function applyAction(
  ctx: ToolContext,
  action: Action,
  outcome: ActionOutcome,
): ActionResult {
  switch (action.type) {
    case "move":
      return applyMove(ctx, action, outcome);
    case "use_technique":
      return applyUseTechnique(ctx, action, outcome);
    case "interact":
      return applyInteract(ctx, action, outcome);
  }
}
