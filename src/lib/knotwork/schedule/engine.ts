// The backward scheduler (PRD P0-1). PURE: no database, no clock, no Next. Everything is a function of the plan, the
// wedding date and today.
//
// Rule 1 of CLAUDE.md lives here: a task has no date of its own. It has a lead time, a buffer before the wedding and
// dependencies; its dates come out of computeSchedule every time they are needed.
//
//   due      = the wedding minus the task's buffer, and no later than the start-by date of any unfinished task that
//              depends on it
//   startBy  = due - leadDays
//   earliest = today, or when its unfinished dependencies can be finished if that is later
//   slack    = startBy - earliest
//   state    = done | late (due is before today) | impossible (due is still ahead, but the lead time no longer fits)
//              | ok
//
// Checked against an independent Python oracle on every fixture (tools/schedule_oracle.py).
import { createHash } from 'node:crypto';
import { addDays, diffDays, type Day } from '../days';

export type PlanTask = { id: string; title: string; leadDays: number; bufferDays: number; dependsOn: string[]; done: boolean };
export type TaskState = 'done' | 'ok' | 'late' | 'impossible';
export type TaskDates = { due: Day; startBy: Day; earliestStart: Day | null; slackDays: number | null; needDays: number | null; state: TaskState };
export type Invalid = { kind: 'duplicate-id' | 'negative-days' | 'missing-dependency' | 'cycle'; ids: string[] };
export type Schedule =
  | { invalid: Invalid; tasks?: undefined; criticalPath?: undefined; runwayDays?: undefined; marginDays?: undefined }
  | { invalid: null; tasks: Record<string, TaskDates>; criticalPath: string[]; runwayDays: number; marginDays: number | null };
export type MovePreview = {
  deltaDays: number;
  tasks: Record<string, { due: Day; startBy: Day; state: TaskState }>;
  late: { id: string; isNew: boolean }[];
  impossible: { id: string; isNew: boolean }[];
  resolved: string[];
  marginDays: number | null;
  fingerprint: string;
};

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Why a plan cannot be scheduled at all, or null. Checked before any write that changes a task or a dependency. */
export function validatePlan(tasks: PlanTask[]): Invalid | null {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const t of tasks) (seen.has(t.id) ? dup : seen).add(t.id);
  if (dup.size) return { kind: 'duplicate-id', ids: [...dup].sort(byId) };
  const whole = (n: number) => Number.isInteger(n) && n >= 0;
  const bad = tasks.filter((t) => !whole(t.leadDays) || !whole(t.bufferDays)).map((t) => t.id);
  if (bad.length) return { kind: 'negative-days', ids: bad.sort(byId) };
  const missing = tasks.filter((t) => t.dependsOn.some((d) => !seen.has(d))).map((t) => t.id);
  if (missing.length) return { kind: 'missing-dependency', ids: missing.sort(byId) };
  // Kahn's algorithm; what it cannot remove sits on a cycle or downstream of one. Then keep only the tasks that can
  // reach themselves, so the answer names the cycle and not its bystanders.
  const left = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
  for (let progress = true; progress; ) {
    progress = false;
    for (const [id, deps] of left) {
      if ([...deps].every((d) => !left.has(d))) {
        left.delete(id);
        progress = true;
      }
    }
  }
  if (!left.size) return null;
  const reachesItself = (start: string) => {
    const stack = [...left.get(start)!].filter((d) => left.has(d));
    const visited = new Set<string>();
    while (stack.length) {
      const n = stack.pop()!;
      if (n === start) return true;
      if (visited.has(n)) continue;
      visited.add(n);
      for (const d of left.get(n)!) if (left.has(d)) stack.push(d);
    }
    return false;
  };
  return { kind: 'cycle', ids: [...left.keys()].filter(reachesItself).sort(byId) };
}

/** Dependencies before dependents. The plan must be valid. */
function topo(tasks: PlanTask[]): PlanTask[] {
  const by = new Map(tasks.map((t) => [t.id, t]));
  const out: PlanTask[] = [];
  const placed = new Set<string>();
  const visit = (t: PlanTask) => {
    if (placed.has(t.id)) return;
    placed.add(t.id);
    for (const d of [...t.dependsOn].sort(byId)) visit(by.get(d)!);
    out.push(t);
  };
  for (const t of [...tasks].sort((a, b) => byId(a.id, b.id))) visit(t);
  return out;
}

/** Each task's distance from the wedding, and who set it. `need` of a task counts its unfinished dependents only. */
function needs(tasks: PlanTask[]) {
  const order = topo(tasks);
  const dependents = new Map<string, PlanTask[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.dependsOn) dependents.get(d)!.push(t);
  const need = new Map<string, number>();
  const via = new Map<string, string | null>(); // the dependent that set this task's due date, if any
  for (const t of [...order].reverse()) {
    let tail = t.bufferDays;
    let who: string | null = null;
    for (const u of dependents.get(t.id)!.filter((x) => !x.done).sort((a, b) => byId(a.id, b.id))) {
      const n = need.get(u.id)!;
      if (n > tail || (n === tail && who === null)) [tail, who] = [n, u.id]; // on a tie with the buffer, the dependent
    }
    need.set(t.id, t.leadDays + tail);
    via.set(t.id, who);
  }
  return { order, need, via };
}

/**
 * The longest chain of lead times back from the wedding among unfinished tasks (D-21). `runwayDays` is how many days
 * before the wedding the first task on it has to start. Does not depend on the date or on today.
 */
export function criticalPath(tasks: PlanTask[]): { ids: string[]; runwayDays: number } {
  const bad = validatePlan(tasks);
  if (bad) throw new Error(`plan is invalid: ${bad.kind} (${bad.ids.join(', ')})`);
  const { need, via } = needs(tasks);
  const open = tasks.filter((t) => !t.done).sort((a, b) => need.get(b.id)! - need.get(a.id)! || byId(a.id, b.id));
  if (!open.length) return { ids: [], runwayDays: 0 };
  const ids: string[] = [];
  for (let at: string | null = open[0]!.id; at; at = via.get(at)!) ids.push(at);
  return { ids, runwayDays: need.get(open[0]!.id)! };
}

/** Every task's dates and state for a wedding date, as of `today`. */
export function computeSchedule(tasks: PlanTask[], weddingDate: Day, today: Day): Schedule {
  const invalid = validatePlan(tasks);
  if (invalid) return { invalid };
  const { order, need } = needs(tasks);
  const by = new Map(tasks.map((t) => [t.id, t]));
  const finish = new Map<string, Day>(); // earliest finish of each unfinished task
  const out: Record<string, TaskDates> = {};
  for (const t of order) {
    const startBy = addDays(weddingDate, -need.get(t.id)!);
    const due = addDays(startBy, t.leadDays);
    if (t.done) {
      out[t.id] = { due, startBy, earliestStart: null, slackDays: null, needDays: null, state: 'done' };
      continue;
    }
    let earliestStart = today;
    for (const d of t.dependsOn) {
      const f = by.get(d)!.done ? null : finish.get(d)!;
      if (f && diffDays(f, earliestStart) > 0) earliestStart = f;
    }
    finish.set(t.id, addDays(earliestStart, t.leadDays));
    const slackDays = diffDays(startBy, earliestStart);
    const state: TaskState = diffDays(due, today) < 0 ? 'late' : slackDays < 0 ? 'impossible' : 'ok';
    out[t.id] = { due, startBy, earliestStart, slackDays, needDays: need.get(t.id)!, state };
  }
  const path = criticalPath(tasks);
  const anyOpen = tasks.some((t) => !t.done);
  // Keys in the plan's own order, so the result reads like the plan.
  const ordered = Object.fromEntries(tasks.map((t) => [t.id, out[t.id]!]));
  return { invalid: null, tasks: ordered, criticalPath: path.ids, runwayDays: path.runwayDays, marginDays: anyOpen ? diffDays(weddingDate, today) - path.runwayDays : null };
}

/** What a preview showed, in 16 hex characters. A commit must present the same one (D-10). */
export function fingerprint(to: Day, tasks: Record<string, { due: Day; startBy: Day; state: TaskState }>): string {
  const lines = Object.keys(tasks).sort(byId).map((id) => `${id}|${tasks[id]!.due}|${tasks[id]!.startBy}|${tasks[id]!.state}\n`);
  return createHash('sha256').update(`knotwork-move-v1\n${to}\n${lines.join('')}`).digest('hex').slice(0, 16);
}

/**
 * What moving the wedding from `from` to `to` does: every task's new dates, what is now late, what is now impossible
 * (each marked new or already so), and what the move resolves. Writes nothing; there is nothing to write, because
 * no date is stored.
 */
export function previewMove(tasks: PlanTask[], from: Day, to: Day, today: Day): MovePreview {
  const [before, after] = [computeSchedule(tasks, from, today), computeSchedule(tasks, to, today)];
  if (before.invalid || after.invalid) throw new Error(`plan is invalid: ${(before.invalid ?? after.invalid)!.kind}`);
  const ids = Object.keys(after.tasks).sort(byId);
  const [b, a] = [before.tasks, after.tasks];
  const now = Object.fromEntries(ids.map((id) => [id, { due: a[id]!.due, startBy: a[id]!.startBy, state: a[id]!.state }]));
  const trouble = (s: TaskState) => s === 'late' || s === 'impossible';
  return {
    deltaDays: diffDays(to, from),
    tasks: now,
    late: ids.filter((id) => a[id]!.state === 'late').map((id) => ({ id, isNew: b[id]!.state !== 'late' })),
    impossible: ids.filter((id) => a[id]!.state === 'impossible').map((id) => ({ id, isNew: b[id]!.state !== 'impossible' })),
    resolved: ids.filter((id) => trouble(b[id]!.state) && a[id]!.state === 'ok'),
    marginDays: after.marginDays,
    fingerprint: fingerprint(to, now),
  };
}
