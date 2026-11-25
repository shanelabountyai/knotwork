import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ageDays, bucketOf, BUCKETS, ledger, noteTemplate, OVERDUE_AFTER_DAYS, showAge, type Obligation } from '@/lib/knotwork/thanks/aging';
import { readJson, ROOT } from './fixtures';

// P1-3, the thank-you obligation ledger without a database: aging is computed from received-on and today, never
// stored. The fixtures' expect blocks are written by thanks/aging.ts (npm run fixtures:check) and recomputed
// independently by tools/thanks_oracle.py under pytest.
const DIR = 'fixtures/thanks';
const files = readdirSync(join(ROOT, DIR)).filter((f) => f.endsWith('.json')).sort();
const o = (id: string, receivedOn: string, extra: Partial<Obligation> = {}): Obligation => ({ source: 'logged', id, giver: `Giver ${id}`, what: 'a vase', receivedOn, acknowledgedOn: null, ...extra });

describe('thank-you fixtures', () => {
  it('there are at least seven', () => expect(files.length).toBeGreaterThanOrEqual(7));
  it.each(files)('%s', (f) => {
    const fx = readJson<{ today: string; obligations: Obligation[]; expect: unknown }>(`${DIR}/${f}`);
    expect(ledger(fx.obligations, fx.today)).toEqual(fx.expect);
  });
});

describe('aging (PRD P1-3: "14 unthanked > 3 weeks")', () => {
  it('is whole days from received-on, never negative, and "> 3 weeks" means more than 21 days', () => {
    expect([ageDays('2027-06-01', '2027-06-01'), ageDays('2027-06-01', '2027-06-22'), ageDays('2027-06-01', '2027-06-23'), ageDays('2027-06-05', '2027-06-01')]).toEqual([0, 21, 22, 0]);
    expect(OVERDUE_AFTER_DAYS).toBe(21);
    const l = ledger([o('a', '2027-06-01'), o('b', '2027-06-02'), o('c', '2027-06-20')], '2027-06-23');
    expect([l.overdue, l.headline]).toEqual([1, '1 unthanked > 3 weeks']);
    expect(l.owed.map((x) => [x.id, x.ageDays, x.overdue])).toEqual([['a', 22, true], ['b', 21, false], ['c', 3, false]]);
  });
  it('the buckets cover every age exactly once, in order', () => {
    for (let d = 0; d < 400; d++) expect(BUCKETS.filter((b) => d >= b.from && (b.to === null || d <= b.to)), String(d)).toHaveLength(1);
    expect([0, 6, 7, 21, 22, 42, 43, 365].map(bucketOf)).toEqual(['fresh', 'fresh', 'weeks', 'weeks', 'late', 'late', 'later', 'later']);
  });
  it('a sent thank-you leaves the count and the buckets, whatever its age; the rest are oldest first', () => {
    const l = ledger([o('old', '2027-01-01', { acknowledgedOn: '2027-01-05' }), o('new', '2027-06-01'), o('mid', '2027-03-01')], '2027-06-10');
    expect(l.owed.map((x) => x.id)).toEqual(['mid', 'new']);
    expect(l.thanked.map((x) => x.id)).toEqual(['old']);
    expect([l.total, l.overdue, l.buckets.map((b) => b.count)]).toEqual([3, 1, [0, 1, 0, 1]]);
  });
  it('reads people\'s words: today, 1 day, 23 days', () => {
    expect([showAge(0), showAge(1), showAge(23)]).toEqual(['today', '1 day', '23 days']);
  });
});

describe('the note template: text only, and never an amount (P0-5)', () => {
  it('names the giver and the gift, and is signed by the couple', () => {
    expect(noteTemplate({ source: 'logged', giver: 'Great-aunt Odile', what: 'the linen napkins' }, 'Juniper Vale & Rowan Ashby')).toBe('Dear Great-aunt Odile,\n\nThank you so much for the linen napkins. It was so thoughtful of you.\n\nWith love,\nJuniper Vale & Rowan Ashby');
    expect(noteTemplate({ source: 'pooled', giver: 'The Lindqvists', what: 'Honeymoon canoe trip' }, 'J & R')).toContain('for giving toward Honeymoon canoe trip.');
    expect(noteTemplate({ source: 'claimed', giver: 'The Ashbys', what: 'Cast-iron skillet' }, 'J & R')).toContain('for the Cast-iron skillet from our registry.');
    for (const source of ['pooled', 'claimed', 'logged'] as const) expect(noteTemplate({ source, giver: 'X', what: 'Y' }, 'Z')).not.toMatch(/\$|\d/);
  });
  it('an obligation has no field for money', () => {
    const keys = Object.keys(ledger([o('a', '2027-01-01')], '2027-02-01').owed[0]!);
    expect(keys.sort()).toEqual(['acknowledgedOn', 'ageDays', 'bucket', 'giver', 'id', 'overdue', 'receivedOn', 'source', 'what']);
  });
});
