// The before/after of a change (PRD P0-2, "universal change log"). PURE.

export type Plain = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const jsonable = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v === undefined ? null : v);

/**
 * Only the fields that changed. A create has `before: null` and every field of `after`; a delete the reverse.
 * Returns null when nothing changed, so a no-op edit writes no log entry.
 */
export function diff(before: Plain | null, after: Plain | null): { before: Plain | null; after: Plain | null } | null {
  const clean = (o: Plain) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, jsonable(v)]));
  if (!before && !after) return null;
  if (!before) return { before: null, after: clean(after!) };
  if (!after) return { before: clean(before), after: null };
  const [b, a] = [clean(before), clean(after)];
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !same(b[k], a[k])).sort();
  if (!keys.length) return null;
  return { before: Object.fromEntries(keys.map((k) => [k, b[k] ?? null])), after: Object.fromEntries(keys.map((k) => [k, a[k] ?? null])) };
}

const VERB_TEXT: Record<string, string> = {
  created: 'added', updated: 'changed', deleted: 'removed', proposed: 'proposed', approved: 'approved', declined: 'declined', withdrawn: 'withdrew',
  expired: 'expired', moved: 'moved', raised: 'flagged', acknowledged: 'acknowledged', generated: 'generated', granted: 'granted', revoked: 'revoked', paid: 'paid', taken: 'took',
  hidden: 'made private', revealed: 'revealed', linked: 'linked', unlinked: 'unlinked',
  shared: 'shared', unshared: 'made private', executed: 'put into action', ticked: 'ticked off', unticked: 'unticked',
  locked: 'locked', unlocked: 'unlocked', relinked: 'replaced the link of',
};

/** 'knotwork.vendor.updated' → { entity: 'vendor', verb: 'updated', text: 'changed' }; null for an action that is not ours. */
export function parseAction(action: string): { entity: string; verb: string; text: string } | null {
  const m = /^knotwork\.([a-z]+)\.([a-z]+)$/.exec(action);
  return m ? { entity: m[1]!, verb: m[2]!, text: VERB_TEXT[m[2]!] ?? m[2]! } : null;
}
