import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * A single DTM event as read back from storage. Mirrors the on-disk JSON
 * event shape documented in docs/BACKEND_ARCHITECTURE.md.
 */
export interface DtmEvent {
  id: number;
  experienceId: string;
  timestamp: number;
  type: string;
  entityId: string | null;
  nodeId: string | null;
  positionX: number | null;
  positionY: number | null;
  payload: unknown;
}

export interface DtmEventInput {
  experienceId: string;
  timestamp: number;
  type: string;
  entityId?: string;
  nodeId?: string;
  position?: { x: number; y: number };
  payload?: unknown;
}

/** Newest-first ordering: later timestamp wins, ties broken by later id. */
function byRecency(a: DtmEvent, b: DtmEvent): number {
  return b.timestamp - a.timestamp || b.id - a.id;
}

/** Oldest-first ordering: earlier timestamp wins, ties broken by earlier id. */
function byChronology(a: DtmEvent, b: DtmEvent): number {
  return a.timestamp - b.timestamp || a.id - b.id;
}

/**
 * The engine's memory system: an append-only, timestamped event log.
 * Single source of truth — state/ is a derived view computed from this.
 *
 * Backed by a plain JSON file (an array of DtmEvent). The whole log is held
 * in memory and rewritten on each append — simple, dependency-free, and a fit
 * for this single-session-per-process beta (see docs/BACKEND_ARCHITECTURE.md).
 * The path is still called `dbPath` for call-site compatibility; it points at
 * a `.json` file.
 */
export class Dtm {
  private readonly path: string;
  private readonly events: DtmEvent[];
  private nextId: number;

  constructor(dbPath: string) {
    this.path = dbPath;
    this.events = [];
    this.nextId = 1;

    if (existsSync(dbPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(dbPath, "utf-8"));
        if (Array.isArray(parsed)) {
          this.events = parsed as DtmEvent[];
          this.nextId = this.events.reduce((max, e) => Math.max(max, e.id), 0) + 1;
        }
      } catch {
        // A missing/empty/corrupt file just means an empty log — start fresh
        // rather than crash a playthrough on a bad or partially-written file.
      }
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.events, null, 2));
  }

  /** Appends a new event. Never updates or deletes — DTM is append-only. */
  append(event: DtmEventInput): number {
    const stored: DtmEvent = {
      id: this.nextId++,
      experienceId: event.experienceId,
      timestamp: event.timestamp,
      type: event.type,
      entityId: event.entityId ?? null,
      nodeId: event.nodeId ?? null,
      positionX: event.position?.x ?? null,
      positionY: event.position?.y ?? null,
      payload: event.payload ?? null,
    };
    this.events.push(stored);
    this.persist();
    return stored.id;
  }

  /** All events for an Experience/playthrough, oldest first. */
  allForExperience(experienceId: string): DtmEvent[] {
    return this.events.filter((e) => e.experienceId === experienceId).sort(byChronology);
  }

  /** All events concerning a specific entity, oldest first. */
  forEntity(experienceId: string, entityId: string): DtmEvent[] {
    return this.events
      .filter((e) => e.experienceId === experienceId && e.entityId === entityId)
      .sort(byChronology);
  }

  /** The most recent N events for an Experience, newest first. */
  recent(experienceId: string, limit: number): DtmEvent[] {
    return this.events
      .filter((e) => e.experienceId === experienceId)
      .sort(byRecency)
      .slice(0, Math.max(0, limit));
  }

  /** The most recent position-bearing event for an entity, if any (used by state/). */
  lastPosition(experienceId: string, entityId: string): DtmEvent | null {
    return (
      this.events
        .filter((e) => e.experienceId === experienceId && e.entityId === entityId && e.nodeId !== null)
        .sort(byRecency)[0] ?? null
    );
  }

  /**
   * The most recent `turn.scheduled` event for an entity, if any (used by
   * scheduler/ to derive when a character is next due — same "sheet is
   * static, state is derived from the log" pattern as lastPosition). No
   * event yet means the character has never taken a scheduled turn, so
   * scheduler/ treats them as due immediately.
   */
  lastScheduledTurn(experienceId: string, entityId: string): DtmEvent | null {
    return (
      this.events
        .filter(
          (e) => e.experienceId === experienceId && e.entityId === entityId && e.type === "turn.scheduled",
        )
        .sort(byRecency)[0] ?? null
    );
  }

  close(): void {
    // No open handle to release — every append writes through synchronously.
  }
}
