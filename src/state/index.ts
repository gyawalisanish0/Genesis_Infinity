import type { Dtm } from "../dtm/index.js";
import type { LoadedExperience } from "../data/loaders/experience.js";
import type {
  CharacterSheet,
  EffectDef,
  HitPoints,
  InventoryEntry,
  ItemDef,
} from "../data/schemas/character.js";
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
 * timeline/index.ts, docs/BACKEND_ARCHITECTURE.md).
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
  /**
   * Current inventory: the sheet's starting entries with `quantity`
   * decremented by `item.consumed` events and `equipped` toggled by
   * `item.toggled` events — the same "sheet is static, state is derived"
   * pattern used for position and debuffs.
   */
  inventory: InventoryEntry[];
  /** sheet's armorClass/hitPoints with activeDebuffs' and equipped items' deltas applied, plus cumulative healing. */
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
 * A character's current inventory: the sheet's starting entries with
 * `quantity` decremented by each `item.consumed` event and `equipped`
 * flipped by each `item.toggled` event.
 */
function currentInventory(
  dtm: Dtm,
  experienceId: string,
  characterId: string,
  baseInventory: InventoryEntry[],
): InventoryEntry[] {
  const inventory = new Map(baseInventory.map((entry) => [entry.itemId, { ...entry }]));

  for (const event of dtm.forEntity(experienceId, characterId)) {
    if (event.type === "item.consumed") {
      const { itemId } = event.payload as { itemId: string };
      const entry = inventory.get(itemId);
      if (entry) {
        entry.quantity = Math.max(0, entry.quantity - 1);
      }
    } else if (event.type === "item.toggled") {
      const { itemId, equipped } = event.payload as { itemId: string; equipped: boolean };
      const entry = inventory.get(itemId);
      if (entry) {
        entry.equipped = equipped;
      }
    }
  }

  return Array.from(inventory.values());
}

/**
 * Total instant healing a character has received from consumed items.
 * `healAmount` is snapshotted directly into each `item.consumed` event's
 * payload at the moment of use (see tools/'s applyItemUse), so this
 * doesn't need to re-look the item up in the (possibly changed) catalog.
 * Permanent — unlike debuffs, healing doesn't decay or expire.
 */
function totalHealingReceived(dtm: Dtm, experienceId: string, characterId: string): number {
  return dtm
    .forEntity(experienceId, characterId)
    .filter((event) => event.type === "item.consumed")
    .reduce((sum, event) => sum + ((event.payload as { healAmount?: number }).healAmount ?? 0), 0);
}

/**
 * Applies active debuffs' and currently-equipped items' armorClassDelta/
 * maxHitPointsDelta to a sheet's base stats, plus any cumulative healing
 * received. This is an engine-computed fact, the same way scope/ computes
 * direction rather than leaving spatial reasoning to the model — rules/
 * shouldn't have to sum deltas out of activeDebuffs/inventory itself. Max
 * HP floors at 0; current HP is clamped to the effective max.
 */
function computeEffectiveStats(
  sheet: CharacterSheet,
  activeDebuffs: AppliedDebuff[],
  inventory: InventoryEntry[],
  items: ItemDef[],
  healingReceived: number,
): EffectiveStats {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const equippedItems = inventory
    .filter((entry) => entry.equipped)
    .map((entry) => itemsById.get(entry.itemId))
    .filter((item): item is ItemDef => item !== undefined);

  const armorClassDelta =
    activeDebuffs.reduce((sum, d) => sum + (d.armorClassDelta ?? 0), 0) +
    equippedItems.reduce((sum, item) => sum + (item.armorClassDelta ?? 0), 0);
  const maxHitPointsDelta =
    activeDebuffs.reduce((sum, d) => sum + (d.maxHitPointsDelta ?? 0), 0) +
    equippedItems.reduce((sum, item) => sum + (item.maxHitPointsDelta ?? 0), 0);

  const armorClass = sheet.armorClass !== undefined ? sheet.armorClass + armorClassDelta : undefined;

  let hitPoints: HitPoints | undefined;
  if (sheet.hitPoints) {
    const max = Math.max(0, sheet.hitPoints.max + maxHitPointsDelta);
    const current = Math.min(sheet.hitPoints.current + healingReceived, max);
    hitPoints = { max, current };
  }

  return { armorClass, hitPoints };
}

/**
 * Computes the current state snapshot for a loaded Experience: every
 * character's sheet, current node, active debuffs, effective stats (sheet +
 * debuffs applied), and the current node's environmental codes, derived
 * from dtm/ rather than stored independently (see docs/BACKEND_ARCHITECTURE.md,
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
    const inventory = currentInventory(dtm, loaded.experience.id, sheet.id, sheet.inventory);
    const healingReceived = totalHealingReceived(dtm, loaded.experience.id, sheet.id);
    const location = findNode(world, nodeId);
    return {
      sheet,
      nodeId,
      activeDebuffs,
      inventory,
      effectiveStats: computeEffectiveStats(
        sheet,
        activeDebuffs,
        inventory,
        loaded.ruleset.items,
        healingReceived,
      ),
      environmentalCodes: mergeEnvironmentalCodes(location.region, location.node),
    };
  });

  return { experienceId: loaded.experience.id, currentTurn, characters };
}
