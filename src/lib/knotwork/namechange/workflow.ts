// P1-4, the name-change sequence: the ordered workflow and its gating. PURE.
//
// The workflow is data (rules/name-change/<jurisdiction>.json, shaped by rules.ts): steps in order, federal → state →
// passport → accounts, each with the steps it waits for (prerequisites) and the documents it needs (artifacts). Some
// documents come out of a step (the new Social Security card out of the federal step), so they can be held only once
// that step is done.
//
// GATING (D-115). A step can be started, or marked done, only when every prerequisite step is done and every artifact
// it needs is held. What is true afterwards, and what every move below keeps true:
//   - a started step has all its prerequisites done and all its artifacts held;
//   - a done step has all its prerequisites done;
//   - a held artifact that a step produces has that step done.
// So a move that would break one of those is refused too: reopening a done step that a later step already relies on,
// reopening a step whose product is held (or whose documents are no longer held: it would be in progress without
// them), or giving up a document a step in progress still needs.
//
// RULE 1: a step stores no date but the day it was finished (a date of fact). The "from" day shown for a step is the
// wedding date plus its startAfterDays, worked out here on read. It is a planning placeholder, never a gate.
//
// Checked against an independent Python oracle on every fixture (tools/namechange_oracle.py).
import { addDays, type Day } from '../days';

export const PHASES = ['federal', 'state', 'passport', 'accounts'] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABEL: Record<Phase, string> = { federal: 'Federal', state: 'State', passport: 'Passport', accounts: 'Accounts' };

export type Artifact = { key: string; label: string; producedBy: string | null };
export type Step = { key: string; phase: Phase; title: string; notes: string; prerequisites: string[]; artifacts: string[]; startAfterDays: number };
export type Ruleset = { jurisdiction: string; name: string; fallback: boolean; illustrative: true; notice: string; artifacts: Artifact[]; steps: Step[] };

export type StepStatus = 'todo' | 'started' | 'done';
export type Progress = { steps: Record<string, StepStatus>; held: string[] };
export const OPS = ['start', 'finish', 'stop', 'reopen', 'hold', 'release'] as const;
export type Op = { op: (typeof OPS)[number]; key: string };
export type Refusal =
  | 'unknown-step' | 'unknown-artifact'
  | 'not-todo' | 'already-done' | 'not-started' | 'not-done'
  | 'prerequisites' | 'artifacts' | 'dependents' | 'produced-held'
  | 'already-held' | 'not-held' | 'not-produced' | 'in-use';
export type Check = { ok: true } | { ok: false; code: Refusal; keys: string[] };

export const REFUSAL_TEXT: Record<Refusal, string> = {
  'unknown-step': 'That step is not in this workflow.',
  'unknown-artifact': 'That document is not in this workflow.',
  'not-todo': 'That step has already been started.',
  'already-done': 'That step is already done.',
  'not-started': 'That step has not been started.',
  'not-done': 'That step is not done.',
  prerequisites: 'Finish the steps it waits for first',
  artifacts: 'Mark the documents it needs as held first',
  dependents: 'A later step that relies on it has already begun',
  'produced-held': 'You already hold what this step produced; mark it as not held first',
  'already-held': 'You already hold that document.',
  'not-held': 'That document is not marked as held.',
  'not-produced': 'That document comes out of a step that is not done yet',
  'in-use': 'A step in progress still needs it',
};

const sorted = (xs: Iterable<string>) => [...xs].sort();

/**
 * What is wrong with a ruleset's shape beyond its types (rules.ts checks the types): keys are unique; every
 * prerequisite is an earlier step in the same or an earlier phase (so the file's order is an order the steps can be
 * done in); phases never go backwards; every artifact named exists and is needed by some step; an artifact a step
 * produces is needed only by steps that (transitively) wait for that step. Empty when it is sound.
 */
export function checkRules(r: Ruleset): string[] {
  const problems: string[] = [];
  const dup = (xs: string[], what: string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      if (seen.has(x)) problems.push(`${what} "${x}" appears twice`);
      seen.add(x);
    }
  };
  dup(r.steps.map((s) => s.key), 'step');
  dup(r.artifacts.map((a) => a.key), 'artifact');
  const index = new Map(r.steps.map((s, i) => [s.key, i]));
  const artifacts = new Map(r.artifacts.map((a) => [a.key, a]));
  const rank = (p: Phase) => PHASES.indexOf(p);
  const before = new Map<string, Set<string>>(); // each step's transitive prerequisites
  r.steps.forEach((s, i) => {
    if (i > 0 && rank(s.phase) < rank(r.steps[i - 1]!.phase)) problems.push(`step "${s.key}" (${s.phase}) comes after a ${r.steps[i - 1]!.phase} step`);
    dup(s.prerequisites, `prerequisite of "${s.key}"`);
    dup(s.artifacts, `artifact of "${s.key}"`);
    const all = new Set<string>();
    for (const p of s.prerequisites) {
      const at = index.get(p);
      if (at === undefined) problems.push(`step "${s.key}" waits for "${p}", which is not a step`);
      else if (at >= i) problems.push(`step "${s.key}" waits for "${p}", which comes later`);
      else {
        if (rank(r.steps[at]!.phase) > rank(s.phase)) problems.push(`step "${s.key}" waits for "${p}", in a later phase`);
        all.add(p);
        for (const q of before.get(p) ?? []) all.add(q);
      }
    }
    before.set(s.key, all);
    for (const a of s.artifacts) {
      const art = artifacts.get(a);
      if (!art) problems.push(`step "${s.key}" needs "${a}", which is not an artifact`);
      else if (art.producedBy && !all.has(art.producedBy)) problems.push(`step "${s.key}" needs "${a}", which comes out of "${art.producedBy}", a step it does not wait for`);
    }
  });
  for (const a of r.artifacts) {
    if (a.producedBy && !index.has(a.producedBy)) problems.push(`artifact "${a.key}" comes out of "${a.producedBy}", which is not a step`);
    if (!r.steps.some((s) => s.artifacts.includes(a.key))) problems.push(`artifact "${a.key}" is not needed by any step`);
  }
  return problems;
}

export const emptyProgress = (): Progress => ({ steps: {}, held: [] });
const statusOf = (p: Progress, key: string): StepStatus => p.steps[key] ?? 'todo';

/** What stands between a step and being started or finished: prerequisites not done, artifacts not held. */
export function blockers(r: Ruleset, p: Progress, key: string): { prerequisites: string[]; artifacts: string[] } {
  const s = r.steps.find((x) => x.key === key)!;
  return { prerequisites: s.prerequisites.filter((q) => statusOf(p, q) !== 'done'), artifacts: s.artifacts.filter((a) => !p.held.includes(a)) };
}

/** May this move be made now? Refusals are checked in a fixed order, so the same state gives the same answer. */
export function check(r: Ruleset, p: Progress, op: Op): Check {
  const no = (code: Refusal, keys: string[] = []): Check => ({ ok: false, code, keys: sorted(keys) });
  if (op.op === 'hold' || op.op === 'release') {
    const a = r.artifacts.find((x) => x.key === op.key);
    if (!a) return no('unknown-artifact');
    const held = p.held.includes(a.key);
    if (op.op === 'hold') {
      if (held) return no('already-held');
      if (a.producedBy && statusOf(p, a.producedBy) !== 'done') return no('not-produced', [a.producedBy]);
      return { ok: true };
    }
    if (!held) return no('not-held');
    const using = r.steps.filter((s) => statusOf(p, s.key) === 'started' && s.artifacts.includes(a.key)).map((s) => s.key);
    return using.length ? no('in-use', using) : { ok: true };
  }
  const s = r.steps.find((x) => x.key === op.key);
  if (!s) return no('unknown-step');
  const status = statusOf(p, s.key);
  const gates = (): Check => {
    const b = blockers(r, p, s.key);
    if (b.prerequisites.length) return no('prerequisites', b.prerequisites);
    if (b.artifacts.length) return no('artifacts', b.artifacts);
    return { ok: true };
  };
  switch (op.op) {
    case 'start':
      return status !== 'todo' ? no('not-todo') : gates();
    case 'finish':
      return status === 'done' ? no('already-done') : gates();
    case 'stop':
      return status !== 'started' ? no('not-started') : { ok: true };
    case 'reopen': {
      if (status !== 'done') return no('not-done');
      const dependents = r.steps.filter((d) => d.prerequisites.includes(s.key) && statusOf(p, d.key) !== 'todo').map((d) => d.key);
      if (dependents.length) return no('dependents', dependents);
      const produced = r.artifacts.filter((a) => a.producedBy === s.key && p.held.includes(a.key)).map((a) => a.key);
      if (produced.length) return no('produced-held', produced);
      return gates(); // reopened, it is in progress again, so it needs its documents again
    }
  }
}

/** The progress after an allowed move. The caller has checked it. */
export function apply(p: Progress, op: Op): Progress {
  const steps = { ...p.steps };
  const set = (status: StepStatus) => {
    if (status === 'todo') delete steps[op.key];
    else steps[op.key] = status;
  };
  switch (op.op) {
    case 'start': set('started'); break;
    case 'finish': set('done'); break;
    case 'stop': set('todo'); break;
    case 'reopen': set('started'); break;
    case 'hold': return { steps, held: sorted([...p.held, op.key]) };
    case 'release': return { steps, held: p.held.filter((a) => a !== op.key) };
  }
  return { steps, held: [...p.held] };
}

/** The three facts the gating keeps true (see the top of this file). Empty when the progress is sound. */
export function invariantProblems(r: Ruleset, p: Progress): string[] {
  const out: string[] = [];
  for (const s of r.steps) {
    const status = statusOf(p, s.key);
    if (status === 'todo') continue;
    const b = blockers(r, p, s.key);
    if (b.prerequisites.length) out.push(`${s.key} is ${status} before ${b.prerequisites.join(', ')}`);
    if (status === 'started' && b.artifacts.length) out.push(`${s.key} is in progress without ${b.artifacts.join(', ')}`);
  }
  for (const a of r.artifacts) if (a.producedBy && p.held.includes(a.key) && statusOf(p, a.producedBy) !== 'done') out.push(`${a.key} is held before ${a.producedBy} is done`);
  return out;
}

/** Plays moves from an empty start: each move's answer, and where it ends. For the fixtures and the oracle. */
export function replay(r: Ruleset, ops: Op[]): { outcomes: Check[]; final: Progress } {
  let p = emptyProgress();
  const outcomes = ops.map((op) => {
    const c = check(r, p, op);
    if (c.ok) p = apply(p, op);
    return c;
  });
  return { outcomes, final: { steps: Object.fromEntries(Object.entries(p.steps).sort(([a], [b]) => (a < b ? -1 : 1))), held: p.held } };
}

export type BoardStep = Step & { status: StepStatus; from: Day; completedOn: Day | null; canStart: boolean; canFinish: boolean; waitingFor: string[]; needs: string[] };
export type Board = { phases: { phase: Phase; label: string; steps: BoardStep[] }[]; artifacts: (Artifact & { held: boolean; canHold: boolean; canRelease: boolean; producedByTitle: string | null })[]; done: number; total: number; next: string[] };

/** Everything the page shows, for one partner, as of now. `completed` holds the days of fact. */
export function board(r: Ruleset, p: Progress, weddingDay: Day, completed: Readonly<Record<string, Day>> = {}): Board {
  const title = new Map(r.steps.map((s) => [s.key, s.title]));
  const steps: BoardStep[] = r.steps.map((s) => {
    const b = blockers(r, p, s.key);
    return {
      ...s, status: statusOf(p, s.key), from: addDays(weddingDay, s.startAfterDays), completedOn: completed[s.key] ?? null,
      canStart: check(r, p, { op: 'start', key: s.key }).ok, canFinish: check(r, p, { op: 'finish', key: s.key }).ok,
      waitingFor: b.prerequisites.map((k) => title.get(k)!), needs: b.artifacts.map((k) => r.artifacts.find((a) => a.key === k)!.label),
    };
  });
  return {
    phases: PHASES.map((phase) => ({ phase, label: PHASE_LABEL[phase], steps: steps.filter((s) => s.phase === phase) })).filter((x) => x.steps.length),
    artifacts: r.artifacts.map((a) => ({
      ...a, held: p.held.includes(a.key), canHold: check(r, p, { op: 'hold', key: a.key }).ok, canRelease: check(r, p, { op: 'release', key: a.key }).ok,
      producedByTitle: a.producedBy ? title.get(a.producedBy)! : null,
    })),
    done: steps.filter((s) => s.status === 'done').length,
    total: steps.length,
    next: steps.filter((s) => s.status === 'todo' && s.canStart).map((s) => s.key),
  };
}
