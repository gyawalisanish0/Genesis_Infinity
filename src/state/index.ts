import type { Dtm } from "../dtm/index.js";
import type { LoadedExperience } from "../data/loaders/experience.js";
import type { CharacterSheet, EffectDef, HitPoints } from "../data/schemas/character.js";
import type { EnvironmentalCode, World } from "../data/schemas/world.js";
import { findNode, mergeEnvironmentalCodes } from "../data/schemas/world.js";

/**
 * An EffectDef as actually applied to a character at a point in time.
 * EffectDef itself (id/name/description/severity/deltas) is Experience-
 * authored ruleset data (see data/schemas/character.ts, resolved into
 * loaded.ruleset.effects) — this adds the bookkeeping for how long it stays
 * active. `appliedAtUnit`/`expiresAtUnit` are timeline/ units (real-wall-
 * clock-anchored), not turn counts — an effect's duration is meant to
 * behave consistently regardless of how many turns pass in that span (see
 * timeline/index.ts, docs/ARCHITECTURE.md).
 */
export interface AppliedDebuff extends EffectDef {
  appliedAtUnit: number;
  expiresAtUnit: number;
}

/**
 * A character's sheet stats after applying active debuffs' deltas. Fields
 * are undefined if the sheet doesn't declare that stat at all — a debuff
 * can't materialize a stat a character doesn't have.
 */
export interface EffectiveStats {
  armorClass?: number;
  hitPoints?: HitPoints;
}

export interface CharacterState {
  sheet: CharacterSheet;
  nodeId: string;
  /** Currently active (non-expired) debuffs on this character. */
  activeDebuffs: AppliedDebuff[];
  /** sheet's armorClass/hitPoints with activeDebuffs' deltas applied. */
  effectiveStats: EffectiveStats;
  /**
   * The current node's merged environmental codes (node overrides region).
   * Surfaced here — not just in scope/'s per-turn payload — so rules/'s
   * tri-state judgment can factor hazards into valid/neutral/invalid
   * decisions (e.g. acting while a toxic atmosphere is mechanically active).
   */
  environmentalCodes: EnvironmentalCode[];
}

export interface StateSnapshot {
  experienceId: string;
  currentTurn: number;
  characters: CharacterState[];
}

/**
 * A character's current node: the most recent position-bearing dtm event
 * for them, or their Experience-declared starting node if none exists yet.
 */
function currentNodeId(
  dtm: Dtm,
  experienceId: string,
  characterId: string,
  startingNodeId: string,
): string {
  const last = dtm.lastPosition(experienceId, characterId);
  return last?.nodeId ?? startingNodeId;
}

/** A character's currently active (non-expired as of currentTimelineUnit) debuffs. */
function activeDebuffsFor(
  dtm: Dtm,
  experienceId: string,
  characterId: string,
  currentTimelineUnit: number,
): AppliedDebuff[] {
  return dtm
    .forEntity(experienceId, characterId)
    .filter((event) => event.type === "debuff.applied")
    .map((event) => event.payload as AppliedDebuff)
    .filter((debuff) => debuff.expiresAtUnit > currentTimelineUnit);
}

/**
 * Applies active debuffs' armorClassDelta/maxHitPointsDelta to a sheet's
 * base stats. This is an engine-computed fact, the same way scope/ computes
 * direction rather than leaving spatial reasoning to the model — rules/
 * shouldn't have to sum deltas out of activeDebuffs itself. Max HP floors
 * at 0; current HP is clamped down if the effective max drops below it.
 */
function computeEffectiveStats(sheet: CharacterSheet, activeDebuffs: AppliedDebuff[]): EffectiveStats {
  const armorClassDelta = activeDebuffs.reduce((sum, d) => sum + (d.armorClassDelta ?? 0), 0);
  const maxHitPointsDelta = activeDebuffs.reduce((sum, d) => sum + (d.maxHitPointsDelta ?? 0), 0);

  const armorClass = sheet.armorClass !== undefined ? sheet.armorClass + armorClassDelta : undefined;

  let hitPoints: HitPoints | undefined;
  if (sheet.hitPoints) {
    const max = Math.max(0, sheet.hitPoints.max + maxHitPointsDelta);
    hitPoints = { max, current: Math.min(sheet.hitPoints.current, max) };
  }

  return { armorClass, hitPoints };
}

/**
 * Computes the current state snapshot for a loaded Experience: every
 * character's sheet, current node, active debuffs, effective stats (sheet +
 * debuffs applied), and the current node's environmental codes, derived
 * from dtm/ rather than stored independently (see docs/ARCHITECTURE.md,
 * "State"). `currentTurn` is the engine's turn counter, echoed into the
 * snapshot (AI-visible, e.g. via rules/'s judgment). `currentTimelineUnit`
 * is a separate, real-wall-clock-anchored value (see timeline/index.ts)
 * used only internally here, to filter out expired debuffs — it is not
 * itself added to the snapshot, so this doesn't make the timeline
 * AI-visible.
 */
export function getState(
  dtm: Dtm,
  loaded: LoadedExperience,
  world: World,
  currentTurn: number,
  currentTimelineUnit: number,
): StateSnapshot {
  const startingNodeIds = new Map(
    (loaded.experience.characters ?? []).map((placement) => [
      placement.characterId,
      placement.startingNodeId,
    ]),
  );

  const characters = loaded.characters.map((sheet): CharacterState => {
    const startingNodeId = startingNodeIds.get(sheet.id);
    if (startingNodeId === undefined) {
      throw new Error(`Character "${sheet.id}" has no starting placement in this Experience`);
    }
    const nodeId = currentNodeId(dtm, loaded.experience.id, sheet.id, startingNodeId);
    const activeDebuffs = activeDebuffsFor(dtm, loaded.experience.id, sheet.id, currentTimelineUnit);
    const location = findNode(world, nodeId);
    return {
      sheet,
      nodeId,
      activeDebuffs,
      effectiveStats: computeEffectiveStats(sheet, activeDebuffs),
      environmentalCodes: mergeEnvironmentalCodes(location.region, location.node),
    };
  });

  return { experienceId: loaded.experience.id, currentTurn, characters };
}
