import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allows, canSeeEntity, GRANT_SCOPES, isPartner, type Capability, type GrantScope } from '@/lib/knotwork/access';
import { rollup } from '@/lib/knotwork/budget';
import { diff, parseAction } from '@/lib/knotwork/changelog-diff';
import { todayIn } from '@/lib/knotwork/days';
import { parseCents, usd } from '@/lib/knotwork/money';
import { BRIEF_SECTIONS, renderBrief, VENDOR_CATEGORIES, type BriefInput } from '@/lib/knotwork/vendors/brief';
import { flagForScopeChange, flagsForDateMove, hhmm, parseHHMM, SCOPE_FIELDS, scopeChanges, type VendorScope } from '@/lib/knotwork/vendors/scope';
import { readJson, ROOT } from './fixtures';

describe('the pure files stay pure', () => {
  // Engines import nothing from the database, the template's core, or Next; so they run anywhere and test without Postgres.
  const PURE = ['days.ts', 'money.ts', 'budget.ts', 'access.ts', 'changelog-diff.ts', 'schedule/engine.ts', 'schedule/template.ts', 'schedule/rsvp.ts', 'consent/machine.ts', 'vendors/scope.ts', 'vendors/brief.ts', 'guests/plus-one.ts', 'guests/backfill.ts', 'guests/headcount.ts', 'guests/chase.ts', 'guests/csv.ts', 'guests/projection.ts', 'gifts/ledger.ts', 'gifts/projection.ts', 'uploads/sniff.ts', 'uploads/inspect.ts', 'uploads/caps.ts', 'photos/moderation.ts', 'photos/wall.ts', 'photos/zip.ts', 'photos/limits.ts', 'photos/dates.ts', 'photos/projection.ts', 'secrecy/compartment.ts', 'secrecy/lens.ts', 'funding/ledger.ts', 'registry/links.ts', 'thanks/aging.ts', 'namechange/workflow.ts', 'contingency/tree.ts', 'contingency/preview.ts', 'seating/engine.ts', 'dashboard/figures.ts', 'vendors/projection.ts', 'photos/classifier.ts', 'guests/delivery.ts', 'lifeadmin/recurrence.ts', 'vendors/payments.ts'];
  it.each(PURE)('%s', (f) => {
    const src = readFileSync(join(ROOT, 'src/lib/knotwork', f), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.filter((i) => !(i.startsWith('.') || i === 'node:crypto'))).toEqual([]);
    expect(src).not.toMatch(/\bDate\.now\(|new Date\(\)/); // no clock: "now" is always an argument
  });
  it('every file in src/lib/knotwork is either on the pure list or a store', () => {
    const all = globSync('**/*.ts', { cwd: join(ROOT, 'src/lib/knotwork') }).sort();
    const stores = ['changelog.ts', 'consent/execute.ts', 'consent/store.ts', 'schedule/store.ts', 'vendors/store.ts', 'context.ts', 'budget-store.ts', 'guests/store.ts', 'guests/public.ts', 'guests/same-site.ts', 'gifts/store.ts', 'gifts/couple.ts', 'gifts/public.ts', 'uploads/process.ts', 'uploads/read.ts', 'photos/blobs.ts', 'photos/qr.ts', 'photos/store.ts', 'photos/public.ts', 'vendors/attachments.ts', 'secrecy/seal.ts', 'secrecy/store.ts', 'secrecy/views.ts', 'secrecy/export.ts', 'funding/store.ts', 'registry/store.ts', 'thanks/store.ts', 'namechange/store.ts', 'contingency/store.ts', 'namechange/rules.ts', 'contingency/schema.ts', 'seating/store.ts', 'dashboard/store.ts', 'vendors/link.ts', 'vendors/public.ts', 'photos/classify.ts', 'lifeadmin/store.ts'];
    expect(all.filter((f) => !PURE.includes(f) && !stores.includes(f))).toEqual([]);
  });
});

describe('todayIn', () => {
  it('is the calendar day in the wedding time zone, not UTC', () => {
    const at = new Date('2026-11-24T03:30:00Z'); // 9:30 pm on the 23rd in Chicago
    expect(todayIn('America/Chicago', at)).toBe('2026-11-23');
    expect(todayIn('UTC', at)).toBe('2026-11-24');
    expect(todayIn('Pacific/Auckland', at)).toBe('2026-11-24');
  });
});

describe('money', () => {
  it('parses typed dollars to integer cents with no float in between', () => {
    expect(parseCents('1,234.5')).toBe(123450);
    expect(parseCents('$80')).toBe(8000);
    expect(parseCents('0.07')).toBe(7);
    expect(parseCents('19.99')).toBe(1999);
    for (const bad of ['', 'abc', '1.234', '-5', '1,23', '1e3', ' ']) expect(parseCents(bad), bad).toBeNull();
  });
  it('formats cents and refuses a float', () => {
    expect(usd(123450)).toBe('$1,234.50');
    expect(() => usd(10.5)).toThrow();
  });
});

describe('budget rollup (PRD P0-7: estimates vs actuals, integer cents)', () => {
  const fx = readJson<{ categories: Parameters<typeof rollup>[0]; expenses: Parameters<typeof rollup>[1]; expect: ReturnType<typeof rollup> }>('fixtures/budget/rollup.json');
  it('matches the hand-added fixture', () => {
    expect(rollup(fx.categories, fx.expenses)).toEqual(fx.expect);
  });
  it('refuses a float and an expense in an unknown category', () => {
    expect(() => rollup(fx.categories, [{ categoryId: 'c-venue', amountCents: 0.5 }])).toThrow(/integer cents/);
    expect(() => rollup(fx.categories, [{ categoryId: 'nope', amountCents: 5 }])).toThrow(/unknown category/);
  });
  it('an empty budget is zero, not over', () => {
    expect(rollup([], [])).toEqual({ lines: [], estimateCents: 0, actualCents: 0, remainingCents: 0, over: false });
  });
});

describe('vendor re-confirmation flags (PRD P0-2): raised on 100% of scope-touching fixtures', () => {
  type Case = { name: string; status: string; before: VendorScope; after: Partial<VendorScope>; flag: string[]; changed?: string[] };
  const { cases } = readJson<{ cases: Case[] }>('fixtures/vendors/scope-changes.json');
  it('covers every scope field, alone', () => {
    for (const f of SCOPE_FIELDS) expect(cases.some((c) => c.flag.length === 1 && c.flag[0] === f), f).toBe(true);
  });
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const changes = scopeChanges(c.before, c.after);
    const flag = flagForScopeChange({ id: 'v1', status: c.status }, changes);
    expect((flag?.detail.changes as { field: string }[] | undefined)?.map((x) => x.field) ?? []).toEqual(c.flag);
    expect(changes.map((x) => x.field)).toEqual(c.changed ?? c.flag);
    if (flag) expect(flag).toMatchObject({ vendorId: 'v1', reason: 'scope_changed' });
  });
  it('a flag carries the before and after of each field', () => {
    expect(scopeChanges(cases[0]!.before, { countEstimate: 132 })).toEqual([{ field: 'countEstimate', before: 120, after: 132 }]);
  });
  it('a date move flags every booked vendor and nobody else', () => {
    const vendors = [{ id: 'a', status: 'booked' }, { id: 'b', status: 'considering' }, { id: 'c', status: 'booked' }, { id: 'd', status: 'dropped' }];
    expect(flagsForDateMove(vendors, '2027-10-09', '2027-11-20')).toEqual([
      { vendorId: 'a', reason: 'date_moved', detail: { from: '2027-10-09', to: '2027-11-20' } },
      { vendorId: 'c', reason: 'date_moved', detail: { from: '2027-10-09', to: '2027-11-20' } },
    ]);
    expect(flagsForDateMove(vendors, '2027-10-09', '2027-10-09')).toEqual([]);
  });
  it('times of day round-trip', () => {
    expect(parseHHMM('15:00')).toBe(900);
    expect(hhmm(900)).toBe('15:00');
    expect(hhmm(null)).toBe('');
    for (const bad of ['24:00', '9', '12:60', 'noon']) expect(parseHHMM(bad), bad).toBeNull();
  });
});

describe('change-log diff', () => {
  it('keeps only what changed, with before and after', () => {
    expect(diff({ name: 'Venue', estimateCents: 900000, note: null }, { name: 'Venue', estimateCents: 950000, note: null })).toEqual({ before: { estimateCents: 900000 }, after: { estimateCents: 950000 } });
  });
  it('a create and a delete carry the whole row; a no-op carries nothing', () => {
    expect(diff(null, { a: 1 })).toEqual({ before: null, after: { a: 1 } });
    expect(diff({ a: 1 }, null)).toEqual({ before: { a: 1 }, after: null });
    expect(diff({ a: 1, b: undefined }, { a: 1, b: null })).toBeNull();
    expect(diff(null, null)).toBeNull();
  });
  it('dates and missing keys are comparable', () => {
    expect(diff({ on: new Date('2027-01-02T00:00:00Z') }, { on: new Date('2027-01-02T00:00:00Z') })).toBeNull();
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual({ before: { b: null }, after: { b: 2 } });
  });
  it('reads our action names and ignores the template\'s', () => {
    expect(parseAction('knotwork.vendor.updated')).toEqual({ entity: 'vendor', verb: 'updated', text: 'changed' });
    expect(parseAction('member.invited')).toBeNull();
  });
});

describe('access: partners and scoped helper grants (PRD P0-2)', () => {
  const caps: Capability[] = ['schedule.view', 'schedule.edit', 'budget.view', 'budget.edit', 'vendors.view', 'vendors.edit', 'guests.view', 'guests.edit', 'consent.view', 'consent.propose', 'consent.decide', 'activity.view', 'helpers.manage', 'wedding.create'];
  const helper = (...grants: GrantScope[]) => ({ role: 'member', grants });
  it('a partner can do everything; only owner is a partner', () => {
    for (const c of caps) expect(allows({ role: 'owner', grants: [] }, c), c).toBe(true);
    expect(['owner', 'admin', 'member', 'scorekeeper'].filter(isPartner)).toEqual(['owner']);
  });
  it('a helper with no grant sees the schedule and the feed, and nothing else', () => {
    expect(caps.filter((c) => allows(helper(), c))).toEqual(['schedule.view', 'activity.view']);
    expect(caps.filter((c) => allows({ role: 'admin', grants: [] }, c))).toEqual(['schedule.view', 'activity.view']); // admin is a helper here (D-08)
  });
  it('budget-view-only sees the budget and cannot edit it (the PRD example)', () => {
    const who = helper('budget_view');
    expect(allows(who, 'budget.view')).toBe(true);
    expect(allows(who, 'budget.edit')).toBe(false);
    expect(allows(who, 'vendors.view')).toBe(false);
  });
  it('an edit grant includes the view; no grant ever reaches consent or helper management', () => {
    expect(allows(helper('vendors_edit'), 'vendors.view')).toBe(true);
    const everything = helper(...GRANT_SCOPES);
    for (const c of ['consent.view', 'consent.propose', 'consent.decide', 'helpers.manage', 'wedding.create'] as const) expect(allows(everything, c), c).toBe(false);
  });
  it('the feed shows a helper only entities inside their grants', () => {
    expect(canSeeEntity(helper(), 'task')).toBe(true);
    expect(canSeeEntity(helper(), 'expense')).toBe(false);
    expect(canSeeEntity(helper('budget_view'), 'expense')).toBe(true);
    expect(canSeeEntity(helper(...GRANT_SCOPES), 'request')).toBe(false);
    expect(canSeeEntity(helper(...GRANT_SCOPES), 'something-new')).toBe(false);
    expect(canSeeEntity({ role: 'owner', grants: [] }, 'something-new')).toBe(true);
  });
});

describe('vendor brief (PRD P0-7: call-sheet-style, role-filtered, regenerable)', () => {
  const input = (category: BriefInput['vendor']['category']): BriefInput => ({
    wedding: { title: 'Juniper & Rowan', date: '2027-10-09' },
    vendor: { name: 'Example Vendor', category, contactName: 'Sam Example', deliverables: 'As agreed.', arriveMin: 900, departMin: 1320, countEstimate: 120, countDueDaysBefore: 14, countDue: '2027-09-25', contractTotalCents: 1200000, contractSignedOn: null },
    payments: [{ label: 'Balance', amountCents: 800000, due: '2027-09-09', paidOn: null }, { label: 'Deposit', amountCents: 400000, due: '2026-12-13', paidOn: '2026-11-20' }],
    tasks: [{ title: 'Menu tasting', due: '2027-07-11', state: 'ok' }],
    openFlags: [],
  });
  it('a caterer gets counts; a DJ gets music and no counts', () => {
    const caterer = renderBrief(input('caterer')).body;
    expect(caterer).toContain('COUNTS');
    expect(caterer).toContain('- Estimate: 120');
    expect(caterer).toContain('Final count due: Sat, Sep 25, 2027 (14 days before)');
    expect(caterer).not.toContain('MUSIC');
    const dj = renderBrief(input('dj')).body;
    expect(dj).toContain('MUSIC');
    expect(dj).not.toContain('COUNTS');
    expect(dj).not.toContain('120');
  });
  it('every category gets times, deliverables and its own payments in due order', () => {
    for (const c of VENDOR_CATEGORIES) {
      const b = renderBrief(input(c)).body;
      expect(b, c).toContain('- Arrive: 15:00');
      expect(b, c).toContain('DELIVERABLES');
      expect(b.indexOf('Deposit: $4,000.00'), c).toBeLessThan(b.indexOf('Balance: $8,000.00'));
      expect(b, c).toContain('(paid Fri, Nov 20, 2026)');
      expect(Object.keys(BRIEF_SECTIONS)).toContain(c);
    }
  });
  it('open re-confirmation flags lead the brief', () => {
    const i = input('caterer');
    i.openFlags.push({ reason: 'date_moved', raisedOn: '2026-11-23', text: 'The wedding date moved from Sat, Oct 9, 2027 to Sat, Nov 20, 2027' });
    const b = renderBrief(i).body;
    expect(b).toContain('NEEDS RE-CONFIRMATION');
    expect(b.indexOf('NEEDS RE-CONFIRMATION')).toBeLessThan(b.indexOf('ON THE DAY'));
    expect(renderBrief(input('caterer')).body).not.toContain('NEEDS RE-CONFIRMATION');
  });
  it('is regenerable: same inputs, same hash; any change, a new hash; the hash is 16 hex', () => {
    const a = renderBrief(input('caterer'));
    expect(renderBrief(input('caterer'))).toEqual(a);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{16}$/);
    const moved = input('caterer');
    moved.wedding.date = '2027-11-20';
    expect(renderBrief(moved).inputsHash).not.toBe(a.inputsHash);
  });
  it('says what arrives in Phase 2 instead of inventing it', () => {
    expect(renderBrief(input('dj')).body).toContain('do-not-play list: arrive with the guest engine (Phase 2)');
  });
});
