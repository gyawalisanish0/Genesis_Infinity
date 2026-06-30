import type { Dtm } from "../dtm/index.js";
import type { LoadedExperience } from "../data/loaders/experience.js";
import type { CharacterSheet } from "../data/schemas/character.js";

export interface CharacterState {
  sheet: CharacterSheet;
  nodeId: string;
}

export interface StateSnapshot {
  experienceId: string;
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

/**
 * Computes the current state snapshot for a loaded Experience: every
 * character's sheet plus their current node, derived from dtm/ rather than
 * stored independently (see docs/ARCHITECTURE.md, "State").
 */
export function getState(dtm: Dtm, loaded: LoadedExperience): StateSnapshot {
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
    return {
      sheet,
      nodeId: currentNodeId(dtm, loaded.experience.id, sheet.id, startingNodeId),
    };
  });

  return { experienceId: loaded.experience.id, characters };
}
