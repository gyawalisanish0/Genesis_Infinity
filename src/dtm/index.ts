import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

/**
 * A single DTM event as read back from storage. Mirrors the dtm_events
 * schema documented in docs/BACKEND_ARCHITECTURE.md.
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

function toNullableString(value: SQLOutputValue): string | null {
  return value === null ? null : String(value);
}

function toNullableNumber(value: SQLOutputValue): number | null {
  return value === null ? null : Number(value);
}

function rowToEvent(row: Record<string, SQLOutputValue>): DtmEvent {
  const payload = row.payload;
  return {
    id: Number(row.id),
    experienceId: String(row.experience_id),
    timestamp: Number(row.timestamp),
    type: String(row.type),
    entityId: toNullableString(row.entity_id),
    nodeId: toNullableString(row.node_id),
    positionX: toNullableNumber(row.position_x),
    positionY: toNullableNumber(row.position_y),
    payload: payload === null ? null : JSON.parse(String(payload)),
  };
}

/**
 * The engine's memory system: an append-only, timestamped event log.
 * Single source of truth — state/ is a derived view computed from this.
 */
export class Dtm {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dtm_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experience_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        entity_id TEXT,
        node_id TEXT,
        position_x INTEGER,
        position_y INTEGER,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dtm_experience ON dtm_events(experience_id);
      CREATE INDEX IF NOT EXISTS idx_dtm_timestamp ON dtm_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_dtm_entity ON dtm_events(entity_id);
      CREATE INDEX IF NOT EXISTS idx_dtm_type ON dtm_events(type);
    `);
  }

  /** Appends a new event. Never updates or deletes — DTM is append-only. */
  append(event: DtmEventInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO dtm_events
        (experience_id, timestamp, type, entity_id, node_id, position_x, position_y, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.experienceId,
      event.timestamp,
      event.type,
      event.entityId ?? null,
      event.nodeId ?? null,
      event.position?.x ?? null,
      event.position?.y ?? null,
      event.payload !== undefined ? JSON.stringify(event.payload) : null,
    );
    return Number(result.lastInsertRowid);
  }

  /** All events for an Experience/playthrough, oldest first. */
  allForExperience(experienceId: string): DtmEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM dtm_events WHERE experience_id = ? ORDER BY timestamp ASC, id ASC`)
      .all(experienceId);
    return rows.map(rowToEvent);
  }

  /** All events concerning a specific entity, oldest first. */
  forEntity(experienceId: string, entityId: string): DtmEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dtm_events WHERE experience_id = ? AND entity_id = ? ORDER BY timestamp ASC, id ASC`,
      )
      .all(experienceId, entityId);
    return rows.map(rowToEvent);
  }

  /** The most recent N events for an Experience, newest first. */
  recent(experienceId: string, limit: number): DtmEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM dtm_events WHERE experience_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?`,
      )
      .all(experienceId, limit);
    return rows.map(rowToEvent);
  }

  /** The most recent position-bearing event for an entity, if any (used by state/). */
  lastPosition(experienceId: string, entityId: string): DtmEvent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM dtm_events
         WHERE experience_id = ? AND entity_id = ? AND node_id IS NOT NULL
         ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )
      .get(experienceId, entityId);
    return row ? rowToEvent(row) : null;
  }

  /**
   * The most recent `turn.scheduled` event for an entity, if any (used by
   * scheduler/ to derive when a character is next due — same "sheet is
   * static, state is derived from the log" pattern as lastPosition). No
   * event yet means the character has never taken a scheduled turn, so
   * scheduler/ treats them as due immediately.
   */
  lastScheduledTurn(experienceId: string, entityId: string): DtmEvent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM dtm_events
         WHERE experience_id = ? AND entity_id = ? AND type = 'turn.scheduled'
         ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )
      .get(experienceId, entityId);
    return row ? rowToEvent(row) : null;
  }

  close(): void {
    this.db.close();
  }
}
