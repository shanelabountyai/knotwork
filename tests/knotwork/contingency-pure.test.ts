import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fingerprintOf, previewBranch, summary, type World } from '@/lib/knotwork/contingency/preview';
import { parseTree, parseTreeText, STARTER_KEYS, STARTERS } from '@/lib/knotwork/contingency/schema';
import { MAX_DEPTH, MAX_NODES, parsePath, paths, validateTree, walk, type Leaf, type Tree, type TreeNode } from '@/lib/knotwork/contingency/tree';
import { addDays } from '@/lib/knotwork/days';
import { ROOT } from './fixtures';

// P1-6, contingency decision trees, rebuilt from the PRD text (D-91). Validation (no cycles, bounded depth and size,
// every branch ends in a leaf), the walk, and previewBranch: exactly what executing a branch would change, with a
// fingerprint the execute step must match.
const leaf = (title: string, extra: Partial<Leaf> = {}): Leaf => ({ type: 'leaf', title, checklist: [], notify: [], tasks: [], spends: [], ...extra });
const q = (text: string, ...next: string[]): TreeNode => ({ type: 'question', text, branches: next.map((n, i) => ({ label: `answer ${i}`, next: n })) });
const codes = (t: Tree) => validateTree(t).map((p) => `${p.code}:${p.node}`);

const WORLD: World = {
  weddingDay: '2027-10-09', today: '2026-11-24', thresholdCents: 50_000,
  plan: [{ id: 't1', title: 'Book the venue', leadDays: 30, bufferDays: 300, dependsOn: [], done: true }],
  vendors: [
    { id: 'v-barn', name: 'Cedar Hollow Barn', category: 'venue', phone: '918-555-0111', email: 'events@cedarhollow.example' },
    { id: 'v-food', name: 'Fennel & Fig Catering', category: 'caterer', phone: '', email: '' },
  ],
  categories: [{ id: 'c-venue', name: 'Venue', sealed: false }, { id: 'c-mine', name: 'Surprise', sealed: true }],
};
const rain = STARTERS.rain.tree;

describe('the starters (rules/contingency/*.json) are sound trees', () => {
  it('every file is a starter and passes validation; the rain plan has four outcomes', () => {
    expect(globSync('rules/contingency/*.json', { cwd: ROOT }).map((f) => f.replace(/^.*\/(.+)\.json$/, '$1')).sort()).toEqual([...STARTER_KEYS].sort());
    for (const k of STARTER_KEYS) expect(validateTree(STARTERS[k].tree), k).toEqual([]);
    expect(paths(rain)).toEqual([[0, 0], [0, 1], [1], [2]]);
  });
});

describe('validateTree: a tree, bounded, where every branch ends in a leaf', () => {
  it('a sound tree has no problems', () => {
    expect(codes({ root: 'a', nodes: { a: q('?', 'b', 'c'), b: leaf('B'), c: leaf('C') } })).toEqual([]);
  });
  it('a cycle is refused, and named', () => {
    const t: Tree = { root: 'a', nodes: { a: q('?', 'b', 'c'), b: q('?', 'a', 'c2'), c: leaf('C'), c2: leaf('C2') } };
    expect(codes(t)).toContain('cycle:a');
    expect(validateTree(t).find((p) => p.code === 'cycle')!.text).toMatch(/a → b → a/);
    expect(codes({ root: 'a', nodes: { a: q('?', 'a', 'b'), b: leaf('B') } })).toContain('cycle:a'); // a branch back to itself
  });
  it('a node reached by two answers is refused (a tree, not a graph)', () => {
    expect(codes({ root: 'a', nodes: { a: q('?', 'b', 'b2'), b: leaf('B'), b2: q('?', 'b', 'c'), c: leaf('C') } })).toContain('shared-node:b');
  });
  it('a branch to nowhere, an unreachable node, a missing root, too few or too many answers, duplicate answers', () => {
    expect(codes({ root: 'a', nodes: { a: q('?', 'b', 'nowhere'), b: leaf('B') } })).toContain('missing-node:a');
    expect(codes({ root: 'a', nodes: { a: q('?', 'b', 'c'), b: leaf('B'), c: leaf('C'), lost: leaf('Lost') } })).toEqual(['unreachable:lost']);
    expect(codes({ root: 'x', nodes: { a: leaf('A') } })).toEqual(['no-root:x']);
    expect(codes({ root: 'a', nodes: { a: q('?', 'b'), b: leaf('B') } })).toContain('branches:a');
    expect(codes({ root: 'a', nodes: { a: q('?', ...'bcdefgh'.split('')), ...Object.fromEntries('bcdefgh'.split('').map((k) => [k, leaf(k)])) } })).toContain('branches:a');
    const dupe: Tree = { root: 'a', nodes: { a: { type: 'question', text: '?', branches: [{ label: 'Yes', next: 'b' }, { label: ' yes ', next: 'c' }] }, b: leaf('B'), c: leaf('C') } };
    expect(codes(dupe)).toEqual(['duplicate-label:a']);
  });
  it('bounded depth and size', () => {
    // A chain of MAX_DEPTH questions is fine; one more is refused.
    const chain = (n: number): Tree => {
      const nodes: Record<string, TreeNode> = {};
      for (let i = 0; i < n; i++) nodes[`q${i}`] = q('?', i + 1 < n ? `q${i + 1}` : 'end', `stop${i}`);
      for (let i = 0; i < n; i++) nodes[`stop${i}`] = leaf(`Stop ${i}`);
      nodes.end = leaf('End');
      return { root: 'q0', nodes };
    };
    expect(codes(chain(MAX_DEPTH))).toEqual([]);
    expect(codes(chain(MAX_DEPTH + 1))).toContain(`too-deep:q${MAX_DEPTH}`);
    const wide: Tree = { root: 'a', nodes: { a: q('?', 'b', 'c'), b: leaf('B'), c: leaf('C'), ...Object.fromEntries(Array.from({ length: MAX_NODES }, (_, i) => [`x${i}`, leaf(`X${i}`)])) } };
    expect(codes(wide)).toContain('too-many-nodes:');
  });
  it('a leaf\'s task waits only for tasks before it in the same leaf (so the tasks cannot form a circle)', () => {
    const t = (tasks: Leaf['tasks']): Tree => ({ root: 'a', nodes: { a: q('?', 'b', 'c'), b: leaf('B', { tasks }), c: leaf('C') } });
    expect(codes(t([{ key: 'x', title: 'X', leadDays: 1, bufferDays: 1, after: [] }, { key: 'y', title: 'Y', leadDays: 1, bufferDays: 1, after: ['x'] }]))).toEqual([]);
    expect(codes(t([{ key: 'x', title: 'X', leadDays: 1, bufferDays: 1, after: ['y'] }, { key: 'y', title: 'Y', leadDays: 1, bufferDays: 1, after: ['x'] }]))).toEqual(['task-order:b']);
    expect(codes(t([{ key: 'x', title: 'X', leadDays: 1, bufferDays: 1, after: [] }, { key: 'x', title: 'X again', leadDays: 1, bufferDays: 1, after: [] }]))).toEqual(['duplicate-task:b']);
  });
  it('the schema refuses a bad shape before any of that, and text that is not JSON', () => {
    expect(parseTree({ root: 'a', nodes: { a: { type: 'question', text: '?', branches: [] } } })).toMatchObject({ ok: false });
    expect(parseTree({ root: 'a', nodes: { a: leaf('A', { spends: [{ category: 'Venue', description: 'x', amountCents: 10.5 }] }) } })).toMatchObject({ ok: false });
    expect(parseTree({ root: 'a', nodes: { a: { ...leaf('A'), notify: [{ vendorCategory: 'astronaut', message: 'hi' }] } } })).toMatchObject({ ok: false });
    expect(parseTree({ root: 'a', nodes: { a: { ...leaf('A'), extra: 1 } } })).toMatchObject({ ok: false });
    expect(parseTreeText('{not json')).toEqual({ ok: false, problems: ['The plan is not valid JSON.'] });
    expect(parseTree({ root: 'a', nodes: { a: leaf('A', { checklist: [`Call ${'ab'.repeat(32)}`] }) } })).toMatchObject({ ok: false, problems: [expect.stringMatching(/64 hex digits/)] });
    expect(parseTreeText(JSON.stringify({ root: 'a', nodes: { a: q('?', 'a', 'b'), b: leaf('B') } }))).toMatchObject({ ok: false, problems: [expect.stringMatching(/leads back to itself/)] });
    expect(parseTreeText(JSON.stringify({ root: 'only', nodes: { only: leaf('Just do it') } }))).toMatchObject({ ok: true }); // a plan may be one outcome
  });
});

describe('walk and paths', () => {
  it('follows branch indexes; a bad index or a path past a leaf is null', () => {
    expect(walk(rain, [])!.at).toBe('forecast');
    expect(walk(rain, [0])!.at).toBe('inside');
    expect(walk(rain, [0, 1])!.answers.map((a) => a.answer)).toEqual(['Rain most of the afternoon', 'No, put up a tent on the lawn']);
    expect(walk(rain, [3])).toBeNull();
    expect(walk(rain, [2, 0])).toBeNull();
    expect(parsePath('0.1')).toEqual([0, 1]);
    expect(parsePath('')).toEqual([]);
    for (const bad of ['a', '1..2', '-1', '12', '0.'] as const) expect(parsePath(bad), bad).toBeNull();
  });
});

describe('previewBranch: exactly what executing would change', () => {
  it('is null until the questions are answered', () => {
    expect(previewBranch(rain, [], WORLD)).toBeNull();
    expect(previewBranch(rain, [0], WORLD)).toBeNull();
  });
  it('the tent: two tasks with derived dates (one waits for the other), the venue to tell, a spend over the threshold proposed', () => {
    const p = previewBranch(rain, [0, 1], WORLD)!;
    expect(p.leaf).toEqual({ key: 'tent', title: 'Rent a tent for the lawn' });
    expect(p.tasks.map((t) => [t.key, t.startBy, t.due, t.state, t.after])).toEqual([
      ['tent', addDays('2027-10-09', -3), addDays('2027-10-09', -1), 'ok', []], // due = the day before the wedding (the next task waits for it)
      ['tent-check', '2027-10-09', '2027-10-09', 'ok', ['tent']],
    ]);
    expect(p.notify).toEqual([{ vendorId: 'v-barn', name: 'Cedar Hollow Barn', phone: '918-555-0111', email: 'events@cedarhollow.example', message: 'A tent rental company will set up on the lawn the day before.' }]);
    expect(p.items.filter((i) => i.kind === 'notify')).toEqual([{ kind: 'notify', text: 'Tell Cedar Hollow Barn: A tent rental company will set up on the lawn the day before.', vendorId: 'v-barn' }]);
    expect(p.spends).toEqual([{ categoryId: 'c-venue', category: 'Venue', description: 'Tent rental for the lawn', amountCents: 180_000, designated: true }]);
    expect(p.problems).toEqual([]);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(summary(p)).toBe('2 checklist lines, 1 vendor to tell, 2 tasks to add, 0 spends recorded, 1 spend proposed');
  });
  it('showers: a spend at or under the threshold is recorded, not proposed', () => {
    const p = previewBranch(rain, [1], WORLD)!;
    expect(p.spends).toEqual([{ categoryId: 'c-venue', category: 'Venue', description: 'Umbrellas for guests', amountCents: 12_000, designated: false }]);
    expect(previewBranch(rain, [1], { ...WORLD, thresholdCents: 11_999 })!.spends[0]!.designated).toBe(true);
    expect(previewBranch(rain, [1], { ...WORLD, thresholdCents: 12_000 })!.spends[0]!.designated).toBe(false);
  });
  it('a vendor category with nobody booked becomes a checklist line; the florist is not booked', () => {
    const p = previewBranch(rain, [0, 0], WORLD)!;
    expect(p.notify.map((n) => n.name)).toEqual(['Cedar Hollow Barn', 'Fennel & Fig Catering']);
    expect(p.items.map((i) => i.text)).toContain('No florist is booked yet. If you book one, tell them: The arch goes up inside the barn instead of on the lawn.');
  });
  it('a missing category, or a designated spend into a category private to the person, is a problem (nothing runs)', () => {
    expect(previewBranch(rain, [0, 1], { ...WORLD, categories: [] })!.problems).toEqual(['There is no budget category called "Venue". Add it on the budget page, or change the plan.']);
    const mine = previewBranch(rain, [0, 1], { ...WORLD, categories: [{ id: 'c-venue', name: 'Venue', sealed: true }] })!;
    expect(mine.problems[0]).toMatch(/private to you, and \$1,800\.00 needs both of you/);
    expect(previewBranch(rain, [1], { ...WORLD, categories: [{ id: 'c-venue', name: 'Venue', sealed: true }] })!.problems).toEqual([]); // a small one may go into it
  });
  it('the fingerprint changes with anything the preview showed, and with nothing else', () => {
    const a = previewBranch(rain, [0, 1], WORLD)!.fingerprint;
    expect(previewBranch(rain, [0, 1], { ...WORLD })!.fingerprint).toBe(a);
    expect(previewBranch(rain, [0, 1], { ...WORLD, weddingDay: '2027-10-16' })!.fingerprint).not.toBe(a); // the tasks' dates
    expect(previewBranch(rain, [0, 1], { ...WORLD, thresholdCents: 500_000 })!.fingerprint).not.toBe(a); // proposed becomes recorded
    expect(previewBranch(rain, [0, 1], { ...WORLD, vendors: [] })!.fingerprint).not.toBe(a); // nobody to tell
    expect(previewBranch(rain, [0, 1], { ...WORLD, plan: [...WORLD.plan, { id: 't2', title: 'Other', leadDays: 1, bufferDays: 1, dependsOn: [], done: false }] })!.fingerprint).toBe(a); // the rest of the plan does not move these
    expect(fingerprintOf({ x: 1 })).not.toBe(fingerprintOf({ x: 2 }));
  });
  it('a task that no longer fits before the wedding is shown as late or impossible, not hidden', () => {
    const p = previewBranch(rain, [0, 1], { ...WORLD, today: '2027-10-08' })!;
    expect(p.tasks.map((t) => [t.key, t.state])).toEqual([['tent', 'impossible'], ['tent-check', 'impossible']]); // the check waits for a tent that cannot be up in time
  });
});
