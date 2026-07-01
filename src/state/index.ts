import type { Dtm } from "../dtm/index.js";
import type { LoadedExperience } from "../data/loaders/experience.js";
import type { CharacterSheet, EffectDef, HitPoints } from "../data/schemas/character.js";

/**
 * An EffectDef as actually applied to a character at a point in time.
 * EffectDef itself (id/name/description/severity/deltas) is Experience-
 * authored ruleset data (see data/schemas/character.ts, resolved into
 * loaded.ruleset.effects) — this adds the turn-bookkeeping for how long it
 * stays active.
 */
export interface AppliedDebuff extends EffectDef {
  appliedAtTurn: number;
  expiresAtTurn: number;
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

/** A character's currently active (non-expired as of currentTurn) debuffs. */
function activeDebuffsFor(
  dtm: Dtm,
  experienceId: string,
  characterId: string,
  currentTurn: number,
): AppliedDebuff[] {
  return dtm
    .forEntity(experienceId, characterId)
    .filter((event) => event.type === "debuff.applied")
    .map((event) => event.payload as AppliedDebuff)
    .filter((debuff) => debuff.expiresAtTurn > currentTurn);
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
 * character's sheet, current node, active debuffs, and effective stats
 * (sheet + debuffs applied), derived from dtm/ rather than stored
 * independently (see docs/ARCHITECTURE.md, "State"). `currentTurn` is the
 * engine's turn counter, used to filter out expired debuffs.
 */
export function getState(dtm: Dtm, loaded: LoadedExperience, currentTurn: number): StateSnapshot {
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
    const activeDebuffs = activeDebuffsFor(dtm, loaded.experience.id, sheet.id, currentTurn);
    return {
      sheet,
      nodeId: currentNodeId(dtm, loaded.experience.id, sheet.id, startingNodeId),
      activeDebuffs,
      effectiveStats: computeEffectiveStats(sheet, activeDebuffs),
    };
  });

  return { experienceId: loaded.experience.id, currentTurn, characters };
}
