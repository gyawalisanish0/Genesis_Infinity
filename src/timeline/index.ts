/**
 * The engine's timeline: a real-wall-clock-anchored counter, independent of
 * the turn-based dtm timestamp (which counts player inputs, not elapsed
 * time — see docs/ARCHITECTURE.md's DTM section). The timeline advances
 * automatically as real time passes, at a fixed ratio, so durations (e.g.
 * effect/hazard expiry) behave consistently regardless of how many turns a
 * player takes in a given span.
 *
 * `currentUnit()` is a pure, lazily-computed function of elapsed real time
 * — no setInterval, no background process, nothing to dispose. This keeps
 * the mechanism purely internal to engine-side duration math: the AI is
 * never told about it and never has to reason about or advance it.
 */

const UNITS_PER_SECOND = 2;
const MS_PER_UNIT = 1000 / UNITS_PER_SECOND;

export interface Timeline {
  /** The current timeline unit (integer), elapsed since createTimeline was called. */
  currentUnit(): number;
}

/**
 * Starts a new timeline anchored to the moment this is called. `now`
 * defaults to `Date.now` but can be injected for deterministic testing
 * without real sleeps.
 */
export function createTimeline(now: () => number = Date.now): Timeline {
  const startMs = now();
  return {
    currentUnit: () => Math.floor((now() - startMs) / MS_PER_UNIT),
  };
}
