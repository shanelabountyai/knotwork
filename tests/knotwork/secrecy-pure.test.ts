import { describe, expect, it } from 'vitest';
import { hiddenBy, hides, NOBODY, ownSeal, parsePrivacy, PRIVATE_ENTRY, PRIVATE_LABEL, revealDayOf, revealText, sealed, type Compartment, type Seen } from '@/lib/knotwork/secrecy/compartment';
import { lens } from '@/lib/knotwork/secrecy/lens';

// P1-1 secrecy compartments (ADR-001): the rules and the masking function, without a database.
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const H = 'c0000000-0000-4000-8000-000000000003';
const at = (viewerId: string, today = '2027-06-01', partners = [A, B]): Seen => ({ viewerId, partners, weddingDay: '2027-10-09', today });
const mine = (revealDays: number | null): Compartment => ({ privateToId: A, revealDays });
const SHARED: Compartment = { privateToId: null, revealDays: null };

describe('reveal points are an offset from the wedding date, or never (rule 1, D-92)', () => {
  it('works the reveal day out from the wedding date on every read', () => {
    expect(revealDayOf('2027-10-09', 0)).toBe('2027-10-09');
    expect(revealDayOf('2027-10-09', -30)).toBe('2027-09-09');
    expect(revealDayOf('2027-10-09', 1)).toBe('2027-10-10');
    expect(revealDayOf('2027-10-09', null)).toBeNull();
    expect(revealDayOf('2028-01-01', -1)).toBe('2027-12-31'); // the wedding moves, the reveal day with it
  });
  it('is sealed until the reveal day, and shows itself ON that day', () => {
    expect(sealed(mine(0), at(B, '2027-10-08'))).toBe(true);
    expect(sealed(mine(0), at(B, '2027-10-09'))).toBe(false);
    expect(sealed(mine(-7), at(B, '2027-10-01'))).toBe(true);
    expect(sealed(mine(-7), at(B, '2027-10-02'))).toBe(false);
    expect(sealed(mine(null), at(B, '2099-01-01'))).toBe(true); // never: only by hand
    expect(sealed(SHARED, at(B))).toBe(false);
  });
  it('an owner who is no longer a partner holds no secret (D-96)', () => {
    expect(sealed(mine(null), at(B, '2027-06-01', [B]))).toBe(false);
  });
  it('says it in words', () => {
    expect([revealText(0), revealText(-1), revealText(-30), revealText(2), revealText(null)]).toEqual(['until the wedding day', 'until 1 day before the wedding', 'until 30 days before the wedding', 'until 2 days after the wedding', 'until revealed by hand']);
  });
});

describe('who an item is hidden from', () => {
  it('from the other partner, from every helper and from nobody (the export); never from its owner', () => {
    for (const v of [B, H, NOBODY]) expect(hides([mine(0)], at(v)), v).toBe(true);
    expect(hides([mine(0)], at(A))).toBe(false);
    expect(hiddenBy([mine(-30)], at(B))).toEqual({ owner: A, revealsOn: '2027-09-09' });
    expect(ownSeal(mine(-30), at(A))).toEqual({ owner: A, revealsOn: '2027-09-09' });
    expect(ownSeal(mine(-30), at(B))).toBeNull();
  });
  it('inherits: an item sitting in a sealed compartment of the OTHER partner is hidden even if it is shared itself', () => {
    expect(hides([SHARED, mine(0)], at(B))).toBe(true);
    expect(hides([SHARED, mine(0)], at(A))).toBe(false);
    // Both partners keep something in the same line: each sees only what is theirs.
    const theirs: Compartment = { privateToId: B, revealDays: 0 };
    expect(hides([mine(0), theirs], at(A))).toBe(true);
    expect(hides([mine(0), theirs], at(B))).toBe(true);
  });
});

describe('the form field', () => {
  it('reads shared, never, and whole days within ten years either side', () => {
    expect(parsePrivacy('')).toEqual({ private: false });
    expect(parsePrivacy('never')).toEqual({ private: true, revealDays: null });
    expect(parsePrivacy('-30')).toEqual({ private: true, revealDays: -30 });
    expect(parsePrivacy(0)).toEqual({ private: true, revealDays: 0 });
    for (const bad of ['soon', '1.5', '-3651', '3651', '1e3', ' - 3', 'x'] as const) expect(parsePrivacy(bad), bad).toBeNull();
    expect(parsePrivacy(1.5)).toBeNull();
  });
});

describe('the lens: the one masking function', () => {
  const L = lens(at(B));
  const task = { id: 't1', title: 'Engrave the watch', notes: 'gold', ...mine(0), vendor: null };
  const shared = { id: 't2', title: 'Wrap the gift', notes: '', ...SHARED, vendor: null };
  it('a hidden item is a masked line: kind, owner, reveal day; nothing of the row', () => {
    const x = L.task(task);
    expect(x).toEqual({ hidden: true, kind: 'task', label: 'Private task', owner: A, revealsOn: '2027-10-09' });
    expect(JSON.stringify(x)).not.toMatch(/Engrave|gold|t1/);
    expect(L.task(shared)).toEqual({ hidden: false, row: shared, mine: null });
    expect(lens(at(A)).task(task)).toMatchObject({ hidden: false, mine: { owner: A, revealsOn: '2027-10-09' } });
  });
  it('an expense hides with its category or its vendor; a payment with its vendor; a pledge with its category', () => {
    const e = { description: 'Deposit', ...SHARED, category: SHARED, vendor: mine(0) };
    expect(L.expense(e)).toMatchObject({ hidden: true, kind: 'expense', label: 'Private spend' });
    expect(L.expense({ ...e, vendor: null, category: mine(0) })).toMatchObject({ hidden: true });
    expect(L.ofVendor({ label: 'Balance' }, mine(0))).toMatchObject({ hidden: true, label: 'Private vendor' });
    expect(L.ofCategory({ amountCents: 1 }, mine(0))).toMatchObject({ hidden: true, label: 'Private category' });
  });
  it('titles and plans name a hidden task "Private task"', () => {
    expect([...L.titles([task, shared]).values()]).toEqual(['Private task', 'Wrap the gift']);
    expect(L.plan([{ id: 't1', title: 'Engrave the watch', leadDays: 1 }], [task])).toEqual([{ id: 't1', title: 'Private task', leadDays: 1 }]);
  });
  it('a change-log entry about a hidden item keeps nothing but that it happened', () => {
    expect(L.entry({ label: 'Engrave the watch', before: { title: 'x' }, after: { title: 'y' } }, [task])).toEqual({ label: PRIVATE_ENTRY, before: null, after: null, masked: true });
    expect(L.entry({ label: 'a private item', private: true, before: null, after: null }, [])).toMatchObject({ masked: true });
    expect(L.entry({ label: 'Wrap', before: null, after: { a: 1 } }, [shared])).toEqual({ label: 'Wrap', before: null, after: { a: 1 }, masked: false });
  });
  it('a stored or exported copy blanks what the item is and keeps ids and amounts', () => {
    const v = { id: 'v1', name: 'Glasswing', contactName: 'Sam', email: 'x@example.test', phone: '1', notes: 'n', deliverables: 'd', amountCents: 5, ...mine(0) };
    expect(lens(at(NOBODY)).blank('vendor', v, [v])).toEqual({ ...v, name: PRIVATE_LABEL.vendor, contactName: '', email: '', phone: '', notes: '', deliverables: '' });
    expect(lens(at(NOBODY)).blank('vendor', { ...v, ...SHARED }, [SHARED])).toEqual({ ...v, ...SHARED });
    expect(lens(at(NOBODY)).blankFields({ id: 'p', label: 'Balance', amountCents: 9 }, [mine(0)], { label: '' })).toEqual({ id: 'p', label: '', amountCents: 9 });
  });
});
