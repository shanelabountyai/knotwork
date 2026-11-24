// P1-7, the progress dashboard's arithmetic. PURE. Every input is read from an existing engine on each request (the
// scheduler, the budget rollup, the guest counts, the thank-you ledger); nothing here is stored.
import type { TaskState } from '../schedule/engine';

export type TaskFigures = { total: number; done: number; onTrack: number; late: number; impossible: number; onTrackPct: number };

/**
 * Tasks by state, and the share "on track": done, or open with time still to do it (D-126). Late (past due, not
 * done) and impossible (can no longer be finished by its due day) are not. With no task at all the plan is on track.
 */
export function taskFigures(states: readonly TaskState[]): TaskFigures {
  const n = (s: TaskState) => states.filter((x) => x === s).length;
  const total = states.length;
  const [done, onTrack, late, impossible] = [n('done'), n('ok'), n('late'), n('impossible')];
  return { total, done, onTrack, late, impossible, onTrackPct: total ? Math.floor((100 * (done + onTrack)) / total) : 100 };
}

/** Whole percent of `part` in `whole`, rounded down; null when there is no whole to measure against. */
export const percentOf = (part: number, whole: number): number | null => (whole > 0 ? Math.floor((100 * part) / whole) : null);
