import type { Dtm } from "../dtm/index.js";
import type { Timeline } from "../timeline/index.js";
import type { TurnResult } from "../ai/index.js";

/**
 * How far out (in timeline/ units) a character's next turn can land,
 * mapped from a d20 roll — higher roll, sooner turn (see rollToOffset).
 * A single uniform range for every turn, not a faster range for `say`
 * the way docs/BACKEND_ARCHITECTURE.md's Dynamic Timeline-Driven Turn
 * Engine section originally sketched: differentiating by which tool(s)
 * fired during a turn isn't visible at this call site today (ai/'s
 * onToolCall callback is bound once, at session creation, not swappable
 * per-turn) — deferred, tunable like every other constant in this system.
 */
const ACTION_TIMELINE_RANGE = 30;

function rollD20(): number {
  return 1 + Math.floor(Math.random() * 20);
}

/**
 * Maps a d20 roll to a timeline-unit offset — higher roll, smaller
 * offset (sooner turn). Clamped to a minimum of 1 unit so a max roll
 * can never produce a zero/negative offset and refire instantly in a
 * tight loop.
 */
function rollToOffset(range: number): number {
  const roll = rollD20();
  return Math.max(1, Math.round((range * (21 - roll)) / 20));
}

export interface SchedulerOptions {
  dtm: Dtm;
  experienceId: string;
  timeline: Timeline;
  /** Every character in the Experience — player and NPCs alike. */
  characterIds: string[];
  playerCharacterId: string;
  /** Runs one NPC's turn autonomously (see core/'s Engine.runNpcTurn) — the caller is expected to broadcast that turn's own tool_call events itself, mirroring how POST /api/turn already does for the player's own turns. */
  runNpcTurn: (characterId: string) => Promise<TurnResult>;
  /** The player's own current scope (see server/'s currentScope) — attached to turn_done so the sidebar refreshes after an autonomous NPC turn without a separate round trip. */
  getScope: () => unknown;
  /** Pushes an event to every client connected to the persistent GET /api/events stream (see server/index.ts). */
  broadcast: (event: string, data: unknown) => void;
}

export interface Scheduler {
  /**
   * Reports that `characterId` just completed a turn (called by
   * server/'s POST /api/turn handler right after the player's own
   * engine.takeTurn resolves) — rolls, records their next scheduled
   * turn, and re-arms the timer for whoever's now soonest due.
   */
  onCharacterActed(characterId: string): void;
  /**
   * Whether the scheduler is *currently* waiting on the player (their
   * your_turn was already broadcast, or would be if anyone were listening
   * — see below). A freshly-connecting GET /api/events client needs this:
   * the very first armNext() below fires almost immediately (everyone
   * seeded due "now"), often before any client has connected at all, so
   * that first broadcast reaches zero listeners and is otherwise lost —
   * server/'s connection handler calls this right after registering a new
   * client to catch up a client that missed it.
   */
  isWaitingOnPlayer(): boolean;
  /** Stops the pending timer (called on backend switch/unload, same lifecycle as the Engine). */
  dispose(): void;
}

/**
 * Every character — player and NPC alike — has a scheduled next-turn
 * position on the timeline (docs/BACKEND_ARCHITECTURE.md's Dynamic
 * Timeline-Driven Turn Engine, Phase 2), derived from dtm/'s
 * `turn.scheduled` events the same "sheet is static, state is derived
 * from the log" way position/debuffs already are — no event yet means a
 * character has never taken a scheduled turn, so they're due immediately.
 *
 * This is the first background process this engine has ever had:
 * timeline/'s own `currentUnit()` is deliberately pull-based (nothing
 * calls it unless asked), but an NPC's turn has to fire on its own
 * schedule with no inbound request triggering it — `armNext` is a real
 * `setTimeout`, always cleared and re-armed as one, so there is ever
 * only one pending timer for the whole session (single-session beta).
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { dtm, experienceId, timeline, characterIds, playerCharacterId, runNpcTurn, getScope, broadcast } = options;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let waitingOnPlayer = false;

  function dueUnitFor(characterId: string): number {
    const last = dtm.lastScheduledTurn(experienceId, characterId);
    return last ? (last.payload as { nextTurnAtUnit: number }).nextTurnAtUnit : 0;
  }

  function onCharacterActed(characterId: string): void {
    if (characterId === playerCharacterId) {
      waitingOnPlayer = false;
    }
    const nextTurnAtUnit = timeline.currentUnit() + rollToOffset(ACTION_TIMELINE_RANGE);
    dtm.append({
      experienceId,
      timestamp: timeline.currentUnit(),
      type: "turn.scheduled",
      entityId: characterId,
      payload: { nextTurnAtUnit },
    });
    armNext();
  }

  async function runDueNpcTurn(characterId: string): Promise<void> {
    broadcast("turn_start", { characterId });
    try {
      const result = await runNpcTurn(characterId);
      broadcast("turn_done", {
        characterId,
        narration: result.narration,
        reasoning: result.reasoning,
        scope: getScope(),
      });
    } catch (error) {
      // Always logged - an NPC turn runs with no request in flight to
      // return an error to, so the broadcast below (silently dropped if no
      // client happens to be connected right now) is not a reliable way to
      // ever learn a crash happened. A deployed Space's container logs are
      // the one place this is guaranteed to surface.
      console.error(
        `[error] NPC turn for "${characterId}" crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      broadcast("error", { characterId, error: error instanceof Error ? error.message : String(error) });
    }
    onCharacterActed(characterId);
  }

  function armNext(): void {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    // Ties broken player-first: at the very start of an Experience every
    // character is due at unit 0, and this guarantees that first turn
    // always opens with the player, matching how every Experience today
    // already begins with player input rather than an NPC acting first
    // with no context.
    const order = [playerCharacterId, ...characterIds.filter((id) => id !== playerCharacterId)];
    let soonestId = order[0]!;
    let soonestUnit = dueUnitFor(soonestId);
    for (const id of order.slice(1)) {
      const due = dueUnitFor(id);
      if (due < soonestUnit) {
        soonestId = id;
        soonestUnit = due;
      }
    }

    const delayMs = Math.max(0, timeline.unitsToMs(soonestUnit - timeline.currentUnit()));

    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (soonestId === playerCharacterId) {
        // Never auto-resolved — the timeline simply stops advancing until
        // the player actually submits (see onCharacterActed above, called
        // externally once they do).
        waitingOnPlayer = true;
        broadcast("your_turn", { characterId: playerCharacterId });
        return;
      }
      void runDueNpcTurn(soonestId);
    }, delayMs);
  }

  armNext();

  return {
    onCharacterActed,
    isWaitingOnPlayer: () => waitingOnPlayer,
    dispose() {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    },
  };
}
