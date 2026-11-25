// P1-6: a contingency plan from text (the couple's own, or a starter in rules/contingency/). The zod schema checks the
// shape and the bounds of every field; then validateTree (tree.ts, pure) checks that it is a sound tree. Nothing that
// fails either is ever stored. Not on the pure list only because it imports zod.
import { z } from 'zod';
import rain from '../../../../rules/contingency/rain.json';
import lateArrival from '../../../../rules/contingency/late-arrival.json';
import vendorNoShow from '../../../../rules/contingency/vendor-no-show.json';
import { BRANCHES, DAYS_MAX, LEAF_LIMITS, MAX_NODES, NODE_KEY_RE, SPEND_MAX_CENTS, validateTree, VENDOR_CATEGORIES, type Tree } from './tree';

const key = z.string().regex(NODE_KEY_RE, 'a name is lowercase letters, digits and dashes');
const text = (max: number) => z.string().trim().min(1).max(max);
const days = z.number().int().min(0).max(DAYS_MAX);

const question = z.strictObject({ type: z.literal('question'), text: text(200), branches: z.array(z.strictObject({ label: text(80), next: key })).min(BRANCHES.min).max(BRANCHES.max) });
const leaf = z.strictObject({
  type: z.literal('leaf'),
  title: text(120),
  checklist: z.array(text(200)).max(LEAF_LIMITS.checklist).default([]),
  notify: z.array(z.strictObject({ vendorCategory: z.enum(VENDOR_CATEGORIES), message: text(200) })).max(LEAF_LIMITS.notify).default([]),
  tasks: z.array(z.strictObject({ key, title: text(120), leadDays: days, bufferDays: days, after: z.array(key).max(LEAF_LIMITS.tasks).default([]) })).max(LEAF_LIMITS.tasks).default([]),
  spends: z.array(z.strictObject({ category: text(60), description: text(200), amountCents: z.number().int().min(1).max(SPEND_MAX_CENTS) })).max(LEAF_LIMITS.spends).default([]),
});
export const TREE = z.strictObject({
  root: key,
  nodes: z.record(z.string().max(40), z.discriminatedUnion('type', [question, leaf])).refine((n) => Object.keys(n).length <= MAX_NODES, `at most ${MAX_NODES} questions and outcomes`),
});

export const TREE_TEXT_MAX = 60_000;

/** A sound tree, or every reason it is not (shape first, then structure). */
export function parseTree(input: unknown): { ok: true; tree: Tree } | { ok: false; problems: string[] } {
  const parsed = TREE.safeParse(input);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`) };
  const tree = parsed.data as Tree;
  // A run of 64 hex digits is token-shaped: the data export refuses one (INV-34), so it never gets into a plan (as D-107).
  if (/[0-9a-f]{64}/i.test(JSON.stringify(tree))) return { ok: false, problems: ['The plan holds a long code (64 hex digits); take it out.'] };
  const problems = validateTree(tree);
  return problems.length ? { ok: false, problems: problems.map((p) => p.text) } : { ok: true, tree };
}

/** The same from the text of the form. */
export function parseTreeText(text: string): { ok: true; tree: Tree } | { ok: false; problems: string[] } {
  if (text.length > TREE_TEXT_MAX) return { ok: false, problems: ['That plan is too long.'] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['The plan is not valid JSON.'] };
  }
  return parseTree(json);
}

const STARTER_FILES = { rain, 'vendor-no-show': vendorNoShow, 'late-arrival': lateArrival } as const;
export type StarterKey = keyof typeof STARTER_FILES;
/** The starters a new plan can begin from, each checked like any other plan when this module loads. */
export const STARTERS: Readonly<Record<StarterKey, { title: string; tree: Tree }>> = Object.fromEntries(
  Object.entries(STARTER_FILES).map(([k, json]) => {
    const { title, root, nodes } = json as { title: string; root: unknown; nodes: unknown };
    const r = parseTree({ root, nodes });
    if (!r.ok) throw new Error(`rules/contingency/${k}.json: ${r.problems.join('; ')}`);
    return [k, { title, tree: r.tree }];
  }),
) as Record<StarterKey, { title: string; tree: Tree }>;
export const STARTER_KEYS = Object.keys(STARTER_FILES) as StarterKey[];
