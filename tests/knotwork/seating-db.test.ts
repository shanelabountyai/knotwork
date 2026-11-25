import { beforeEach, describe, expect, it } from 'vitest';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import * as seating from '@/app/o/[org]/wedding/guests/seating/actions';
import { exportTables } from '@/app/export-hooks';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { readRsvp } from '@/lib/knotwork/guests/public';
import { applyRsvp } from '@/lib/knotwork/guests/store';
import { generate } from '@/lib/knotwork/seating/engine';
import { loadSeating } from '@/lib/knotwork/seating/store';
import { as, db, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';
import { NOT_FOUND, PAGES, render } from './render';

// P1-5, the seating chart, through the real actions and page: tables, pair rules, generate (reproducible from its
// arrangement number; locked seats kept), manual moves (which lock), and a problem that cannot work refused with its
// reasons and nothing written. Attending guests are seated; those who have not answered only when the couple says so.
const today = () => todayIn('America/Chicago', now());
let c: Couple;
const PAGE = 'src/app/o/[org]/wedding/guests/seating/page.tsx';
const page = async () => render(await PAGES[PAGE]!(), { org: c.slug });
const CSV = `household,name,email,list,priority,age_group,partner_status
The Lindqvists,Linda Lindqvist,linda@lindqvist.example,A,1,adult,married
The Lindqvists,Omar Lindqvist,,A,1,adult,married
The Lindqvists,Wren Lindqvist,,A,1,child,none
The Ashbys,Hal Ashby,hal@ashby.example,A,2,adult,married
The Ashbys,Io Ashby,,A,2,adult,married
The Vales,Ben Vale,ben@vale.example,A,3,adult,married
The Vales,Cy Vale,,A,3,adult,married
The Sterns,Ruth Stern,ruth@stern.example,A,4,adult,none
The Okoros,Chidi Okoro,chidi@okoro.example,B,10,adult,married
`;
const PLAN = { cap: '10', venueMin: '', venueMax: '', perHead: '87.00', kidsMeal: '35.00', vendorMeal: '40.00', lockoutDays: '42', minBatchSeats: '1', mealOptions: 'Chicken, Fish' };
const guest = (name: string) => db.guest.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const table = (name: string) => db.seatingTable.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const state = () => withOrg({ orgId: c.orgId }, (tx) => loadSeating(tx, { orgId: c.orgId }));
const seatsByName = async () => {
  const rows = await db.seat.findMany({ where: { orgId: c.orgId }, include: { guest: { select: { name: true } }, table: { select: { name: true } } } });
  return Object.fromEntries(rows.map((r) => [r.guest.name, `${r.table.name}${r.locked ? ' (locked)' : ''}`]).sort());
};
/** Every guest of a household answers yes (or no). */
async function answer(household: string, attending: boolean, only?: string[]) {
  await withOrg({ orgId: c.orgId }, async (tx) => {
    const h = await tx.household.findFirstOrThrow({ where: { orgId: c.orgId, name: household }, include: { guests: true } });
    await applyRsvp(tx, { orgId: c.orgId, userId: null }, h.id, { ok: true, plusOneName: null, responses: h.guests.filter((g) => !only || only.includes(g.name)).map((g) => ({ guestId: g.id, attending, meal: attending && g.ageGroup === 'adult' ? 'Fish' : null, dietary: [], accessibility: [], songRequest: '' })) });
  });
}

beforeEach(async () => {
  c = await makeWedding(addDays(today(), 300));
  await ok(guestActions.saveGuestPlan(c.slug, PLAN));
  await ok(guestActions.importGuests(c.slug, { csv: CSV, confirm: 'on' }));
  await ok(guestActions.releaseWave(c.slug, { list: 'A' }));
  for (const h of ['The Lindqvists', 'The Ashbys', 'The Vales']) await answer(h, true); // seven coming; Ruth has not answered
  await ok(seating.addSeatingTable(c.slug, { name: 'Table 1', capacity: '4' }));
  await ok(seating.addSeatingTable(c.slug, { name: 'Table 2', capacity: '4' }));
});

describe('generate', () => {
  it('seats everyone who is coming, households together where they fit; the same arrangement number gives the same seating', async () => {
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    const first = await seatsByName();
    expect(Object.keys(first)).toEqual(['Ben Vale', 'Cy Vale', 'Hal Ashby', 'Io Ashby', 'Linda Lindqvist', 'Omar Lindqvist', 'Wren Lindqvist']); // not Ruth, not the Okoros
    const s = await state();
    expect(s.score).toMatchObject({ hard: 0 });
    // Three households of 3, 2 and 2 at two tables of four: one couple has to split... or not: 3 + (2) | (2) + spare.
    expect(s.score.total).toBe(generate(s.problem, 1).score!.total);
    expect(await page()).toContain('7 of 7 guests seated at 2 tables (8 seats).');
    expect(await page()).toContain('1 who have not answered are not.');
    const entry = (await log(c.orgId)).filter((e) => e.action === 'knotwork.seating.generated').at(-1)!;
    expect(entry.data).toMatchObject({ label: 'Seating chart', after: { arrangement: 1, seated: 7, locked: 0, hardProblems: 0 } });
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    expect(await seatsByName()).toEqual(first);
    await ok(seating.generateSeatingChart(c.slug, { seed: '2' }));
    expect((await state()).score.hard).toBe(0);
  });

  it('a hard rule is kept, a soft one weighed; a problem that cannot work is refused with its reasons and nothing changes', async () => {
    const [linda, hal, io, ben, cy, omar, wren] = await Promise.all(['Linda Lindqvist', 'Hal Ashby', 'Io Ashby', 'Ben Vale', 'Cy Vale', 'Omar Lindqvist', 'Wren Lindqvist'].map(guest));
    await ok(seating.addSeatingRule(c.slug, { a: linda!.id, b: omar!.id, kind: 'apart', hard: 'on' }));
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    const s = await seatsByName();
    expect(s['Linda Lindqvist']).not.toBe(s['Omar Lindqvist']);
    expect(await page()).toContain('Linda Lindqvist and Omar Lindqvist must sit apart');

    // Five who must sit together, and the largest table seats four: refused, the rules named, nothing written.
    await ok(seating.addSeatingRule(c.slug, { a: hal!.id, b: io!.id, kind: 'together', hard: 'on' }));
    await ok(seating.addSeatingRule(c.slug, { a: io!.id, b: ben!.id, kind: 'together', hard: 'on' }));
    await ok(seating.addSeatingRule(c.slug, { a: ben!.id, b: cy!.id, kind: 'together', hard: 'on' }));
    await ok(seating.addSeatingRule(c.slug, { a: cy!.id, b: wren!.id, kind: 'together', hard: 'on' }));
    const before = await snapshot();
    await refused(seating.generateSeatingChart(c.slug, { seed: '1' }), /No seating can keep every rule: .*must all sit together: 5 guests, and the largest table seats 4\. Nothing was changed\./);
    expect(await snapshot()).toBe(before);

    // Seats enough, but three guests who must each sit apart from the others at two tables: none exists ("unsolved").
    for (const r of await db.seatingRule.findMany({ where: { orgId: c.orgId } })) await ok(seating.removeSeatingRule(c.slug, { id: r.id }));
    await ok(seating.addSeatingRule(c.slug, { a: linda!.id, b: hal!.id, kind: 'apart', hard: 'on' }));
    await ok(seating.addSeatingRule(c.slug, { a: hal!.id, b: ben!.id, kind: 'apart', hard: 'on' }));
    await ok(seating.addSeatingRule(c.slug, { a: ben!.id, b: linda!.id, kind: 'apart', hard: 'on' }));
    const before2 = await snapshot();
    await refused(seating.generateSeatingChart(c.slug, { seed: '1' }), /No seating was found that keeps every rule marked "must": .* must sit apart, and both are at Table \d\. Nothing was changed\. Loosen one of these rules, or add a table\./);
    expect(await snapshot()).toBe(before2);
    // A third table makes it work.
    await ok(seating.addSeatingTable(c.slug, { name: 'Table 3', capacity: '2' }));
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    const t = await seatsByName();
    expect(new Set([t['Linda Lindqvist'], t['Hal Ashby'], t['Ben Vale']]).size).toBe(3);
  });

  it('refuses a rule twice, a guest with themself, a guest who declined or is not invited; nothing is written', async () => {
    const [linda, hal, chidi] = await Promise.all(['Linda Lindqvist', 'Hal Ashby', 'Chidi Okoro'].map(guest));
    await ok(seating.addSeatingRule(c.slug, { a: hal!.id, b: linda!.id, kind: 'together', hard: '' }));
    const rule = await db.seatingRule.findFirstOrThrow({ where: { orgId: c.orgId } });
    expect([rule.guestAId < rule.guestBId, rule.hard, rule.kind]).toEqual([true, false, 'together']); // stored smaller id first
    const before = await snapshot();
    await refused(seating.addSeatingRule(c.slug, { a: linda!.id, b: hal!.id, kind: 'apart', hard: 'on' }), /already have a rule/);
    await refused(seating.addSeatingRule(c.slug, { a: linda!.id, b: linda!.id, kind: 'apart', hard: 'on' }), /two different guests/);
    await refused(seating.addSeatingRule(c.slug, { a: linda!.id, b: chidi!.id, kind: 'apart', hard: 'on' }), /invited households who have not declined/);
    expect(await snapshot()).toBe(before);
    await expect(db.seatingRule.create({ data: { orgId: c.orgId, kind: 'apart', hard: true, guestAId: rule.guestBId, guestBId: rule.guestAId } })).rejects.toThrow(/SeatingRule_pair_check/);
  });
});

describe('manual moves and locks', () => {
  it('a move by hand locks the seat, a regenerate keeps it, a full table is refused, and an unlocked seat moves again', async () => {
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    const ruthless = await seatsByName();
    const hal = await guest('Hal Ashby');
    const other = ruthless['Hal Ashby'] === 'Table 1' ? 'Table 2' : 'Table 1';
    const target = await table(other);
    const full = Object.values(ruthless).filter((t) => t === other).length === 4;
    if (full) await refused(seating.moveSeatedGuest(c.slug, { guestId: hal.id, tableId: target.id }), new RegExp(`${other} is full \\(4 of 4\\)`));
    // Make room: the third table, and Hal moves there by hand.
    await ok(seating.addSeatingTable(c.slug, { name: 'Head table', capacity: '2' }));
    const head = await table('Head table');
    await ok(seating.moveSeatedGuest(c.slug, { guestId: hal.id, tableId: head.id }));
    expect((await seatsByName())['Hal Ashby']).toBe('Head table (locked)');
    await refused(seating.moveSeatedGuest(c.slug, { guestId: hal.id, tableId: head.id }), /already sits at Head table/);
    // Regenerate with any arrangement: Hal stays, and Io (his household) is drawn to him if there is room.
    for (const seed of ['1', '5']) {
      await ok(seating.generateSeatingChart(c.slug, { seed }));
      expect((await seatsByName())['Hal Ashby']).toBe('Head table (locked)');
    }
    expect((await seatsByName())['Io Ashby']).toBe('Head table');
    // Unlocked, a regenerate may move him; locked again by the button.
    await ok(seating.lockSeat(c.slug, { guestId: hal.id, locked: '' }));
    await refused(seating.lockSeat(c.slug, { guestId: hal.id, locked: '' }), /is not locked/);
    await ok(seating.lockSeat(c.slug, { guestId: hal.id, locked: 'on' }));
    // To no table: he stands, and the page lists him under "Not seated", the score counting it as a problem.
    await ok(seating.moveSeatedGuest(c.slug, { guestId: hal.id, tableId: '' }));
    expect(await seatsByName()).not.toHaveProperty('Hal Ashby');
    expect((await state()).score.hard).toBe(1);
    expect(await page()).toContain('Hal Ashby has no seat.');
    const moves = (await log(c.orgId)).filter((e) => e.action === 'knotwork.seating.moved');
    expect(moves.map((e) => (e.data as { after: unknown }).after)).toEqual([{ table: 'Head table', locked: true }, { table: null, locked: false }]);
  });

  it('a table cannot shrink below who sits there; removing it unseats them; the database refuses an overfull table at commit', async () => {
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    const t1 = await table('Table 1');
    const seated = await db.seat.count({ where: { tableId: t1.id } });
    await refused(seating.updateSeatingTable(c.slug, { id: t1.id, name: 'Table 1', capacity: String(seated - 1) }), new RegExp(`has ${seated} guests seated`));
    await ok(seating.updateSeatingTable(c.slug, { id: t1.id, name: 'Long table', capacity: '6' }));
    await refused(seating.addSeatingTable(c.slug, { name: 'Long table', capacity: '4' }), /already a table with that name/);
    await expect(db.seatingTable.update({ where: { id: t1.id }, data: { capacity: 1 } })).rejects.toThrow(/more guests than it seats/);
    await expect(db.seatingTable.update({ where: { id: t1.id }, data: { capacity: 31 } })).rejects.toThrow(/SeatingTable_capacity_check/);
    await ok(seating.removeSeatingTable(c.slug, { id: t1.id }));
    expect((await state()).score.hard).toBe(seated);
  });
});

describe('who is seated', () => {
  it('guests who have not answered are seated only when the couple says so; a guest who declines loses the seat at the next write', async () => {
    await ok(seating.seatPendingGuests(c.slug, { on: 'on' }));
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    expect(Object.keys(await seatsByName())).toContain('Ruth Stern');
    expect(await page()).toContain('Guests who have not answered are seated too.');
    expect(await page()).toContain('(The Sterns, not answered)');
    // Off again: Ruth's seat is cleared at once.
    await ok(seating.seatPendingGuests(c.slug, { on: '' }));
    expect(Object.keys(await seatsByName())).not.toContain('Ruth Stern');
    // Omar declines: his seat no longer counts anywhere, and the next seating write clears it.
    await answer('The Lindqvists', false, ['Omar Lindqvist']);
    const s = await state();
    expect(s.guests.map((g) => g.name)).not.toContain('Omar Lindqvist');
    expect(s.stale).toBe(1);
    await ok(seating.addSeatingTable(c.slug, { name: 'Table 3', capacity: '2' }));
    expect(Object.keys(await seatsByName())).not.toContain('Omar Lindqvist');
    expect((await log(c.orgId)).some((e) => e.action === 'knotwork.seating.updated' && (e.data as { before?: { seatsOfGuestsNotComing?: number } }).before?.seatsOfGuestsNotComing === 1)).toBe(true);
  });

  it('the seating chart is never on a guest-facing surface: a household\'s RSVP page knows nothing of tables', async () => {
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    const o = await outcome(guestActions.showRsvpLink(c.slug, { id: (await db.household.findFirstOrThrow({ where: { orgId: c.orgId, name: 'The Ashbys' } })).id }));
    const token = String((o.result as { notice: string }).notice).split('/r/')[1]!;
    const view = JSON.stringify(await readRsvp(token, '203.0.113.71'));
    expect(view).toContain('Hal Ashby');
    expect(view).not.toMatch(/Table 1|Table 2|seat|locked/i);
  });
});

describe('access, other workspaces, the export', () => {
  it('a helper without the guest-list grant sees no seating page and can change nothing; with it, can', async () => {
    await as(c.helper);
    expect(await page()).toBe(NOT_FOUND);
    await refused(seating.addSeatingTable(c.slug, { name: 'Helper table', capacity: '4' }), /do not have access/);
    await as(c.a);
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'guests_edit' } });
    await as(c.helper);
    await ok(seating.addSeatingTable(c.slug, { name: 'Helper table', capacity: '4' }));
    expect(await page()).toContain('Helper table');
  });

  it('another workspace\'s table, rule or guest is not found before any rule; the database keeps seats inside one workspace', async () => {
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    const h = await db.household.create({ data: { orgId: other.id, name: 'Theirs' } });
    const [g1, g2] = await Promise.all(['Them One', 'Them Two'].map((name) => db.guest.create({ data: { orgId: other.id, householdId: h.id, name, dietary: [], accessibility: [] } })));
    const t = await db.seatingTable.create({ data: { orgId: other.id, name: 'Theirs', capacity: 4 } });
    const [a, b] = [g1!.id, g2!.id].sort();
    const r = await db.seatingRule.create({ data: { orgId: other.id, kind: 'apart', hard: true, guestAId: a!, guestBId: b! } });
    const mine = await guest('Hal Ashby');
    const before = await snapshot();
    for (const call of [
      () => seating.updateSeatingTable(c.slug, { id: t.id, name: 'Mine now', capacity: '1' }),
      () => seating.removeSeatingTable(c.slug, { id: t.id }),
      () => seating.removeSeatingRule(c.slug, { id: r.id }),
      () => seating.addSeatingRule(c.slug, { a: mine.id, b: g1!.id, kind: 'apart', hard: 'on' }),
      () => seating.moveSeatedGuest(c.slug, { guestId: g1!.id, tableId: '' }),
      () => seating.moveSeatedGuest(c.slug, { guestId: mine.id, tableId: t.id }),
      () => seating.lockSeat(c.slug, { guestId: g1!.id, locked: 'on' }),
    ]) {
      const o = await outcome(call());
      expect(o.nav ?? o.error).toBe('notFound');
    }
    expect(await snapshot()).toBe(before);
    await expect(db.seat.create({ data: { orgId: c.orgId, guestId: mine.id, tableId: t.id } })).rejects.toThrow(/one workspace/);
    await expect(db.seatingRule.create({ data: { orgId: c.orgId, kind: 'apart', hard: true, guestAId: [mine.id, g1!.id].sort()[0]!, guestBId: [mine.id, g1!.id].sort()[1]! } })).rejects.toThrow(/its own workspace/);
  });

  it('the export holds the chart whole', async () => {
    await ok(seating.generateSeatingChart(c.slug, { seed: '1' }));
    const out: Record<string, unknown[]> = {};
    await withOrg({ orgId: c.orgId }, async (tx) => {
      for (const t of exportTables.filter((x) => ['SeatingTable', 'SeatingRule', 'Seat'].includes(x.name))) out[t.name] = await t.rows(tx, c.orgId);
    });
    expect(out.SeatingTable).toHaveLength(2);
    expect(out.Seat).toHaveLength(7);
  });
});
