// P1-6: what executing one branch of a contingency plan would change, exactly. PURE.
//
// `previewBranch` is the whole answer: the checklist lines, which booked vendors to tell (a leaf names a vendor
// category; every booked vendor of that category the person may see is listed, and a category with none becomes a
// checklist line), the tasks to add with the dates the scheduler gives them, and each spend with whether it is
// recorded (at or under the threshold) or only proposed through consent (over it, rule 2). Its fingerprint is what the
// execute step must present: if anything the preview showed has changed (a vendor booked, a task's dates, the
// threshold), executing is refused and the new preview is shown (the commit-must-match-preview rule of P0-1, D-10).
import { createHash } from 'node:crypto';
import { addDays, type Day } from '../days';
import { usd } from '../money';
import { computeSchedule, type PlanTask, type TaskState } from '../schedule/engine';
import { walk, type Leaf, type Tree, type Walk } from './tree';

export type WorldVendor = { id: string; name: string; category: string; phone: string; email: string };
/** `sealed`: private to the person previewing (a designated spend cannot go into it, D-122). */
export type WorldCategory = { id: string; name: string; sealed: boolean };
export type World = { weddingDay: Day; today: Day; plan: PlanTask[]; vendors: WorldVendor[]; categories: WorldCategory[]; thresholdCents: number };

export type ItemLine = { kind: 'check' | 'notify'; text: string; vendorId: string | null };
export type NewTask = { key: string; title: string; leadDays: number; bufferDays: number; after: string[]; due: Day; startBy: Day; state: TaskState };
export type Spend = { categoryId: string | null; category: string; description: string; amountCents: number; designated: boolean };
export type Preview = {
  answers: Walk['answers'];
  leaf: { key: string; title: string };
  items: ItemLine[];
  notify: { vendorId: string; name: string; phone: string; email: string; message: string }[];
  tasks: NewTask[];
  spends: Spend[];
  /** Why this branch cannot be executed as it stands (empty when it can). */
  problems: string[];
  fingerprint: string;
};

const NEW = 'new:';
const CATEGORY_TEXT: Record<string, string> = { dj: 'DJ', other: 'other vendor' };
const categoryText = (c: string) => CATEGORY_TEXT[c] ?? c;

/** The preview for a path that reaches a leaf, or null when it does not (a question still to answer, or a bad index). */
export function previewBranch(tree: Tree, path: readonly number[], world: World): Preview | null {
  const w = walk(tree, path);
  if (!w || w.node.type !== 'leaf') return null;
  const leaf: Leaf = w.node;
  const problems: string[] = [];

  const items: ItemLine[] = leaf.checklist.map((text) => ({ kind: 'check', text, vendorId: null }));
  const notify: Preview['notify'] = [];
  for (const n of leaf.notify) {
    const booked = world.vendors.filter((v) => v.category === n.vendorCategory).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    if (!booked.length) items.push({ kind: 'check', text: `No ${categoryText(n.vendorCategory)} is booked yet. If you book one, tell them: ${n.message}`, vendorId: null });
    for (const v of booked) {
      notify.push({ vendorId: v.id, name: v.name, phone: v.phone, email: v.email, message: n.message });
      items.push({ kind: 'notify', text: `Tell ${v.name}: ${n.message}`, vendorId: v.id });
    }
  }

  // The new tasks join the plan as it is; they wait only for each other, so nothing already on the schedule moves.
  const added: PlanTask[] = leaf.tasks.map((t) => ({ id: `${NEW}${t.key}`, title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, dependsOn: t.after.map((a) => `${NEW}${a}`).sort(), done: false }));
  const schedule = computeSchedule([...world.plan, ...added], world.weddingDay, world.today);
  const tasks: NewTask[] = leaf.tasks.map((t) => {
    const d = schedule.tasks?.[`${NEW}${t.key}`];
    return { key: t.key, title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, after: [...t.after], due: d?.due ?? addDays(world.weddingDay, -t.bufferDays), startBy: d?.startBy ?? addDays(world.weddingDay, -t.bufferDays - t.leadDays), state: d?.state ?? 'ok' };
  });
  if (schedule.invalid) problems.push('These tasks cannot be added to the schedule as it stands.');

  const spends: Spend[] = leaf.spends.map((s) => {
    const c = world.categories.find((x) => x.name.toLowerCase() === s.category.trim().toLowerCase());
    const designated = s.amountCents > world.thresholdCents;
    if (!c) problems.push(`There is no budget category called "${s.category}". Add it on the budget page, or change the plan.`);
    else if (designated && c.sealed) problems.push(`"${c.name}" is private to you, and ${usd(s.amountCents)} needs both of you. Share the category first, or change the plan.`);
    return { categoryId: c?.id ?? null, category: c?.name ?? s.category, description: s.description, amountCents: s.amountCents, designated };
  });

  const shown = { path: [...path], leaf: w.at, items, tasks, spends: spends.map((s) => [s.categoryId, s.amountCents, s.description, s.designated]), problems };
  return { answers: w.answers, leaf: { key: w.at, title: leaf.title }, items, notify, tasks, spends, problems, fingerprint: fingerprintOf(shown) };
}

/** 16 hex characters of what a preview showed. */
export function fingerprintOf(shown: unknown): string {
  return createHash('sha256').update(`knotwork-contingency-v1\n${JSON.stringify(shown)}`).digest('hex').slice(0, 16);
}

/** One line for the change log and the page: "2 tasks, 1 spend proposed, 3 vendors to tell". */
export function summary(p: Preview): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const proposed = p.spends.filter((s) => s.designated).length;
  return [
    n(p.items.filter((i) => i.kind === 'check').length, 'checklist line'),
    n(p.notify.length, 'vendor to tell', 'vendors to tell'),
    n(p.tasks.length, 'task to add', 'tasks to add'),
    n(p.spends.length - proposed, 'spend recorded', 'spends recorded'),
    n(proposed, 'spend proposed', 'spends proposed'),
  ].join(', ');
}
