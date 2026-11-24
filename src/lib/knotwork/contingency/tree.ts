// P1-6, contingency decision trees: the tree's shape and the rules a stored tree must follow. PURE.
//
// Rebuilt from the PRD text (D-91: Showcall's engine is not readable in this run). A plan is a small decision tree: a
// QUESTION node has two to six branches, each with a label and the node it leads to; a LEAF is what to do once the
// questions are answered: checklist lines, booked vendors to tell (by category, matched when the branch is previewed),
// tasks to add to the schedule (lead and buffer days, so their dates derive from the wedding date, rule 1) and spends
// (recorded, or proposed through consent when over the threshold, rule 2).
//
// A sound tree (D-120): the root exists; every branch leads to a node that exists; no node is reached twice (it is a
// tree, so a path names exactly one leaf, and there is no cycle); every node is reachable; at most MAX_DEPTH questions
// on any path and MAX_NODES nodes in all; branch labels differ within a question; a leaf's task waits only for tasks
// listed before it in the same leaf. Together these mean every branch, followed down, ends in a leaf.
import { VENDOR_CATEGORIES, type VendorCategory } from '../vendors/brief';

export const MAX_NODES = 40;
export const MAX_DEPTH = 6;
export const BRANCHES = { min: 2, max: 6 } as const;
export const LEAF_LIMITS = { checklist: 20, notify: 10, tasks: 10, spends: 3 } as const;
export const NODE_KEY_RE = /^[a-z0-9-]{1,40}$/;
export const SPEND_MAX_CENTS = 10_000_000; // $100,000.00
export const DAYS_MAX = 3650;

export type Branch = { label: string; next: string };
export type Question = { type: 'question'; text: string; branches: Branch[] };
export type Notify = { vendorCategory: VendorCategory; message: string };
export type TaskAction = { key: string; title: string; leadDays: number; bufferDays: number; after: string[] };
export type SpendAction = { category: string; description: string; amountCents: number };
export type Leaf = { type: 'leaf'; title: string; checklist: string[]; notify: Notify[]; tasks: TaskAction[]; spends: SpendAction[] };
export type TreeNode = Question | Leaf;
export type Tree = { root: string; nodes: Record<string, TreeNode> };

export type TreeProblem = { code: 'no-root' | 'too-many-nodes' | 'missing-node' | 'cycle' | 'shared-node' | 'unreachable' | 'too-deep' | 'branches' | 'duplicate-label' | 'task-order' | 'duplicate-task' | 'bad-key'; node: string; text: string };

export { VENDOR_CATEGORIES };

/** Everything wrong with a tree, in a fixed order (empty when it is sound). Never loops: the walk is bounded. */
export function validateTree(t: Tree): TreeProblem[] {
  const out: TreeProblem[] = [];
  const keys = Object.keys(t.nodes).sort();
  const add = (code: TreeProblem['code'], node: string, text: string) => out.push({ code, node, text });
  if (keys.length > MAX_NODES) add('too-many-nodes', '', `A plan has at most ${MAX_NODES} questions and outcomes; this one has ${keys.length}.`);
  for (const k of keys) if (!NODE_KEY_RE.test(k)) add('bad-key', k, `"${k}" is not a node name: use lowercase letters, digits and dashes.`);
  if (!(t.root in t.nodes)) {
    add('no-root', t.root, `The first question "${t.root}" is not in the plan.`);
    return out;
  }
  for (const k of keys) {
    const n = t.nodes[k]!;
    if (n.type === 'question') {
      if (n.branches.length < BRANCHES.min || n.branches.length > BRANCHES.max) add('branches', k, `"${k}" needs ${BRANCHES.min} to ${BRANCHES.max} answers; it has ${n.branches.length}.`);
      const labels = n.branches.map((b) => b.label.trim().toLowerCase());
      if (new Set(labels).size !== labels.length) add('duplicate-label', k, `Two answers to "${k}" say the same thing.`);
      for (const b of n.branches) if (!(b.next in t.nodes)) add('missing-node', k, `The answer "${b.label}" to "${k}" leads to "${b.next}", which is not in the plan.`);
    } else {
      const seen = new Set<string>();
      for (const task of n.tasks) {
        if (seen.has(task.key)) add('duplicate-task', k, `Two tasks in "${k}" are both called "${task.key}".`);
        for (const a of task.after) if (!seen.has(a)) add('task-order', k, `The task "${task.key}" in "${k}" waits for "${a}", which is not listed before it.`);
        seen.add(task.key);
      }
    }
  }
  // The walk: depth-first from the root along branches that exist. A node met again is a cycle if it is on the
  // current path, and a shared node otherwise. Bounded by MAX_NODES + 1 visits, so a hostile tree cannot make it spin.
  const reached = new Set<string>();
  const onPath: string[] = [];
  const visit = (k: string, depth: number) => {
    if (onPath.includes(k)) {
      add('cycle', k, `"${k}" leads back to itself through ${[...onPath.slice(onPath.indexOf(k)), k].join(' → ')}.`);
      return;
    }
    if (reached.has(k)) {
      add('shared-node', k, `"${k}" is reached by two answers; each question or outcome belongs to one answer.`);
      return;
    }
    if (reached.size > MAX_NODES) return;
    reached.add(k);
    const n = t.nodes[k]!;
    if (n.type !== 'question') return;
    if (depth + 1 > MAX_DEPTH) {
      add('too-deep', k, `More than ${MAX_DEPTH} questions in a row, at "${k}".`);
      return;
    }
    onPath.push(k);
    for (const b of n.branches) if (b.next in t.nodes) visit(b.next, depth + 1);
    onPath.pop();
  };
  visit(t.root, 0);
  for (const k of keys) if (!reached.has(k)) add('unreachable', k, `No answer leads to "${k}".`);
  return out;
}

export type Walk = { answers: { node: string; question: string; answer: string; index: number }[]; at: string; node: TreeNode };

/**
 * Follows the branch indexes from the root. Null when an index does not exist, or when the path goes on past a leaf.
 * The tree must be sound (every stored tree is).
 */
export function walk(t: Tree, path: readonly number[]): Walk | null {
  let at = t.root;
  const answers: Walk['answers'] = [];
  for (const i of path) {
    const n = t.nodes[at]!;
    if (n.type !== 'question' || !Number.isInteger(i) || i < 0 || i >= n.branches.length) return null;
    answers.push({ node: at, question: n.text, answer: n.branches[i]!.label, index: i });
    at = n.branches[i]!.next;
  }
  return { answers, at, node: t.nodes[at]! };
}

/** Every root-to-leaf path, as branch indexes, in the tree's own order. */
export function paths(t: Tree): number[][] {
  const out: number[][] = [];
  const go = (k: string, path: number[]) => {
    const n = t.nodes[k]!;
    if (n.type === 'leaf') {
      out.push(path);
      return;
    }
    n.branches.forEach((b, i) => go(b.next, [...path, i]));
  };
  go(t.root, []);
  return out;
}

/** '1.0' ⇄ [1, 0]. The empty string is the root. Null for anything else. */
export function parsePath(s: string): number[] | null {
  if (s === '') return [];
  if (!/^\d(\.\d){0,9}$/.test(s)) return null;
  return s.split('.').map(Number);
}
export const showPath = (p: readonly number[]) => p.join('.');
