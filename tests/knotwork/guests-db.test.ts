import { beforeEach, describe, expect, it } from 'vitest';
import { addVendor, approveRequest, proposeBooking, regenerateBrief, updateVendor } from '@/app/o/[org]/wedding/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { hashToken } from '@/core/tokens';
import { parseAction } from '@/lib/knotwork/changelog-diff';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { FORBIDDEN_KEYS } from '@/lib/knotwork/guests/projection';
import { readRsvp, submitRsvp } from '@/lib/knotwork/guests/public';
import { loadChase, loadGuestState, rsvpDeadline } from '@/lib/knotwork/guests/store';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';

const { addDoNotPlay, addGuest, addHousehold, closeBList, importGuests, markCalled, markSaveTheDate, proposeGuestRemoval, recordRsvp, releaseWave, removeDoNotPlay, saveGuestPlan, sendReminders, showRsvpLink, updateGuest, updateHousehold } = guestActions;

// Phase 2 through the real actions and the real RSVP link: P0-3 guest engine, P0-4 tiered backfill.
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let date: string;

// Cap 8. A list: 2 + 2 + 2 + 1(+1 plus-one for Priya, engaged) = 8 seats. B list: Okoro (2), Tran (2), Webb (1).
const CSV = `household,name,email,list,priority,age_group,partner_status
The Lindqvists,Linda Lindqvist,linda@lindqvist.example,A,1,adult,married
The Lindqvists,Omar Lindqvist,,A,1,adult,married
The Sterns,Ruth Stern,ruth@stern.example,A,2,adult,none
The Sterns,Ada Stern,,A,2,child,
The Vales,Ben Vale,,A,3,adult,married
The Vales,Cy Vale,,A,3,adult,married
Priya Rao,Priya Rao,priya@rao.example,A,4,adult,engaged
The Okoros,Chidi Okoro,chidi@okoro.example,B,10,adult,married
The Okoros,Ngozi Okoro,,B,10,adult,married
The Trans,Mai Tran,mai@tran.example,B,11,adult,married
The Trans,Huy Tran,,B,11,adult,married
Sam Webb,Sam Webb,sam@webb.example,B,12,adult,none
`;
const PLAN = { cap: '8', venueMin: '4', venueMax: '10', perHead: '87.00', kidsMeal: '35.00', vendorMeal: '40.00', lockoutDays: '42', minBatchSeats: '3', mealOptions: 'Chicken, Fish, Vegetarian' };
const household = (name: string) => db.household.findFirstOrThrow({ where: { orgId: c.orgId, name }, include: { guests: { orderBy: { createdAt: 'asc' } } } });
const guest = (name: string) => db.guest.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const state = () => withOrg({ orgId: c.orgId }, (tx) => loadGuestState(tx, { orgId: c.orgId }));
const tokenOf = async (name: string) => {
  const o = await outcome(showRsvpLink(c.slug, { id: (await household(name)).id }));
  return String((o.result as { notice: string }).notice).split('/r/')[1]!;
};
const reply = (g: { id: string }, attending: boolean, meal = 'Fish') => ({ guestId: g.id, attending, meal: attending ? meal : '', dietary: [], accessibility: [], songRequest: '' });
const decline = async (name: string) => {
  const h = await household(name);
  expect(await submitRsvp(await tokenOf(name), '203.0.113.9', { responses: h.guests.map((g) => reply(g, false)), plusOneName: '' })).toEqual({ ok: true });
};

beforeEach(async () => {
  date = addDays(today(), 330);
  c = await makeWedding(date);
  await ok(saveGuestPlan(c.slug, PLAN));
  await ok(importGuests(c.slug, { csv: CSV, confirm: 'on' }));
});

describe('import (validated, previewed, all or nothing)', () => {
  it('previews without writing, then writes everything', async () => {
    expect(await db.household.count({ where: { orgId: c.orgId } })).toBe(7);
    expect(await db.guest.count({ where: { orgId: c.orgId } })).toBe(12);
    const before = await snapshot();
    const o = await outcome(importGuests(c.slug, { csv: 'household,name\nThe Nguyens,An Nguyen\n' }));
    expect(o.result).toMatchObject({ notice: expect.stringContaining('would add 1 households and 1 guests') });
    expect(await snapshot()).toBe(before);
  });
  it('refuses a bad file by line, and a file that clashes with the list, writing nothing either time', async () => {
    const before = await snapshot();
    await refused(importGuests(c.slug, { csv: 'household,name,list\nThe Nguyens,An,C\n', confirm: 'on' }), /Line 2: list must be A or B\. Nothing was imported/);
    await refused(importGuests(c.slug, { csv: 'household,name\nThe Nguyens,An Nguyen\nThe Sterns,Someone New\n', confirm: 'on' }), /Already on the guest list: The Sterns\. Nothing was imported/);
    expect(await snapshot()).toBe(before);
  });
});

describe('waves and the cap (PRD P0-4)', () => {
  it('the A wave invites what fits; pending invites hold their seats, so the B list waits', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    const s = await state();
    expect(s.cap).toEqual({ cap: 8, held: 8, attending: 0, pending: 8, declined: 0, available: 0 }); // 7 people + Priya's plus-one
    expect((await household('Priya Rao')).state).toBe('invited');
    await refused(releaseWave(c.slug, { list: 'B' }), /No seats are free/);
    await refused(releaseWave(c.slug, { list: 'A' }), /Nobody is waiting/);
  });

  it('declines free seats; the B list goes out as a batch, never a drip, and never past the cap', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    await decline('The Vales'); // 2 seats free: below the batch minimum of 3, and it is not the whole B list
    expect((await state()).cap.available).toBe(2);
    await refused(releaseWave(c.slug, { list: 'B' }), /Not enough seats are free for a batch yet/);
    await decline('The Sterns'); // 4 free
    await ok(releaseWave(c.slug, { list: 'B' }));
    const invited = (await db.household.findMany({ where: { orgId: c.orgId, list: 'B' }, orderBy: { priority: 'asc' } })).map((h) => [h.name, h.state]);
    expect(invited).toEqual([['The Okoros', 'invited'], ['The Trans', 'invited'], ['Sam Webb', 'queued']]); // priority order, first fit; Sam (1) would fit only after
    const s = await state();
    expect(s.cap.held).toBeLessThanOrEqual(8);
    expect(s.cap).toMatchObject({ held: 8, available: 0 });
    const waves = await db.inviteWave.findMany({ where: { orgId: c.orgId }, orderBy: { number: 'asc' } });
    expect(waves.map((w) => [w.number, w.list, w.householdCount, w.seatCount])).toEqual([[1, 'A', 4, 8], [2, 'B', 2, 4]]);
  });

  it('the race: two releases at once and replies arriving meanwhile never pass the cap or invite a household twice', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    await decline('The Vales');
    await decline('The Sterns');
    const priya = await household('Priya Rao');
    const token = await tokenOf('Priya Rao');
    const results = await Promise.all([
      outcome(releaseWave(c.slug, { list: 'B' })),
      outcome(releaseWave(c.slug, { list: 'B' })),
      submitRsvp(token, '203.0.113.9', { responses: [reply(priya.guests[0]!, true)], plusOneName: 'Robin Rao' }),
    ]);
    expect(results.slice(0, 2).filter((r) => (r as { nav?: string }).nav === 'redirect')).toHaveLength(1); // exactly one release won
    expect(results.slice(0, 2).filter((r) => (r as { error?: string }).error)).toHaveLength(1);
    const s = await state();
    expect(s.cap.held).toBeLessThanOrEqual(s.plan.cap);
    expect(s.cap.held).toBe(8); // Lindqvists 2 + Priya and Robin 2 + Okoros 2 + Trans 2
    expect(await db.inviteWave.count({ where: { orgId: c.orgId, list: 'B' } })).toBe(1);
    const households = await db.household.findMany({ where: { orgId: c.orgId, state: 'invited' } });
    expect(new Set(households.map((h) => h.id)).size).toBe(households.length);
    for (const h of households) expect(h.waveId).not.toBeNull();
  });

  it('adding to an invited household, granting a plus-one, or lowering the cap is refused when it would pass the cap', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    const lind = await household('The Lindqvists');
    const before = await snapshot();
    await refused(addGuest(c.slug, { householdId: lind.id, name: 'Wren Lindqvist', ageGroup: 'child', partnerStatus: 'none' }), /would hold 9 seats against a cap of 8/);
    await refused(saveGuestPlan(c.slug, { ...PLAN, cap: '7' }), /would hold 8 seats against a cap of 7/);
    const vales = await household('The Vales');
    await refused(updateHousehold(c.slug, { id: vales.id, name: vales.name, email: '', phone: '', address1: '', city: '', region: '', postal: '', list: 'A', priority: 3, plusOneOverride: 'grant', plusOneNote: 'Cy is bringing a carer' }), /would hold 9 seats/);
    expect(await snapshot()).toBe(before);
    // A queued household holds nothing, so it can grow freely.
    await ok(addGuest(c.slug, { householdId: (await household('Sam Webb')).id, name: 'Jo Webb', ageGroup: 'adult', partnerStatus: 'none' }));
  });

  it('inside the lockout no B wave goes out and the remaining B list becomes regrets, cleanly', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    await decline('The Vales');
    await decline('The Sterns');
    await refused(closeBList(c.slug, {}), /Nothing to close/); // 330 days out
    goToDay(addDays(date, -41)); // 41 days to go: inside the 42-day lockout
    await as(c.a); // a session does not outlive a jump of weeks
    await refused(releaseWave(c.slug, { list: 'B' }), /Too close to the wedding/);
    await ok(closeBList(c.slug, {}));
    await refused(closeBList(c.slug, {}), /Nothing to close/); // idempotent
    const b = await db.household.findMany({ where: { orgId: c.orgId, list: 'B' } });
    expect(b.map((h) => [h.state, h.invitedOn, h.waveId])).toEqual([['regrets', null, null], ['regrets', null, null], ['regrets', null, null]]);
    expect((await state()).cap).toMatchObject({ held: 4, available: 4 }); // regrets hold nothing; the seats stay free
    expect(await readRsvp('x'.repeat(43), '203.0.113.9')).toBeNull();
    const regrets = (await log(c.orgId)).filter((e) => e.action === 'knotwork.household.updated' && (e.data as { after?: { state?: string } }).after?.state === 'regrets');
    expect(regrets).toHaveLength(3);
  });

  it('a B household moved to the A list before release is released with the A list; after release the list is frozen', async () => {
    const sam = await household('Sam Webb');
    await ok(updateHousehold(c.slug, { id: sam.id, name: sam.name, email: sam.email, phone: '', address1: '', city: '', region: '', postal: '', list: 'A', priority: 0, plusOneOverride: '', plusOneNote: '' }));
    await ok(saveGuestPlan(c.slug, { ...PLAN, cap: '9' }));
    await ok(releaseWave(c.slug, { list: 'A' }));
    expect((await household('Sam Webb')).state).toBe('invited');
    await refused(updateHousehold(c.slug, { id: sam.id, name: sam.name, email: sam.email, phone: '', address1: '', city: '', region: '', postal: '', list: 'B', priority: 0, plusOneOverride: '', plusOneNote: '' }), /list can no longer change/);
  });
});

describe('RSVP through the link, headcount and cost (PRD P0-3)', () => {
  beforeEach(async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
  });

  it('"Linda declined: −$87.00": every reply recalculates the cost and writes the delta feed', async () => {
    const lind = await household('The Lindqvists');
    const token = await tokenOf('The Lindqvists');
    expect(await submitRsvp(token, '203.0.113.9', { responses: lind.guests.map((g) => reply(g, true)), plusOneName: '' })).toEqual({ ok: true });
    expect((await state()).costCents).toBe(2 * 8700);
    expect(await submitRsvp(token, '203.0.113.9', { responses: [reply(lind.guests[0]!, false), reply(lind.guests[1]!, true)], plusOneName: '' })).toEqual({ ok: true });
    const s = await state();
    expect([s.count.attending, s.costCents]).toEqual([1, 8700]);
    const feed = await db.headcountDelta.findMany({ where: { orgId: c.orgId }, orderBy: { at: 'asc' } });
    expect(feed.map((d) => [d.label, d.deltaSeats, d.deltaCents, d.attendingAfter, d.costAfterCents])).toEqual([
      ['Linda accepted', 1, 8700, 1, 8700], ['Omar accepted', 1, 8700, 2, 17400], ['Linda declined', -1, -8700, 1, 8700],
    ]);
    // A child costs a kids meal; a booked vendor who eats on site adds a vendor meal.
    const sterns = await household('The Sterns');
    await submitRsvp(await tokenOf('The Sterns'), '203.0.113.9', { responses: sterns.guests.map((g) => reply(g, true)), plusOneName: '' });
    expect((await state()).costCents).toBe(8700 + 8700 + 3500);
    await ok(addVendor(c.slug, { name: 'Tin Roof Strings', category: 'dj', contactName: '', email: '', phone: '' }));
    const v = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } });
    await ok(updateVendor(c.slug, { id: v.id, name: v.name, category: 'dj', contactName: '', email: '', phone: '', notes: '', deliverables: '', arrive: '', depart: '', countEstimate: '', countDueDaysBefore: '', onSite: 'on', contractTotal: '' }));
    await ok(proposeBooking(c.slug, { id: v.id }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, status: 'pending' } })).id }));
    const s2 = await state();
    expect(s2.count).toMatchObject({ attending: 3, adults: 2, kids: 1, vendorMeals: 1, catererMeals: 4, invited: 7, responded: 4, responseRatePct: 57 });
    expect(s2.costCents).toBe(2 * 8700 + 3500 + 4000);
  });

  it('a plus-one is named through the link only where the rules allow one, and only with someone attending', async () => {
    const priya = await household('Priya Rao');
    const token = await tokenOf('Priya Rao');
    expect(await submitRsvp(token, '203.0.113.9', { responses: [reply(priya.guests[0]!, false)], plusOneName: 'Robin Rao' })).toEqual({ ok: false, message: 'A guest can only come with someone who is attending.' });
    expect(await submitRsvp(token, '203.0.113.9', { responses: [reply(priya.guests[0]!, true)], plusOneName: 'Robin Rao' })).toEqual({ ok: true });
    expect((await household('Priya Rao')).guests.map((g) => [g.name, g.isPlusOne, g.rsvp])).toEqual([['Priya Rao', false, 'attending'], ['Robin Rao', true, 'attending']]);
    const lind = await household('The Lindqvists');
    expect(await submitRsvp(await tokenOf('The Lindqvists'), '203.0.113.9', { responses: lind.guests.map((g) => reply(g, true)), plusOneName: 'Someone Else' })).toEqual({ ok: false, message: 'This invitation does not include a guest.' });
    expect((await household('The Lindqvists')).guests.every((g) => g.rsvp === 'pending')).toBe(true); // a refused reply changes nothing
  });

  it('a link reaches its own household only; a wrong, malformed or not-yet-invited token is the same nothing', async () => {
    const token = await tokenOf('The Lindqvists');
    const sterns = await household('The Sterns');
    expect(await submitRsvp(token, '203.0.113.9', { responses: sterns.guests.map((g) => reply(g, false)), plusOneName: '' })).toEqual({ ok: false, message: 'That reply names someone who is not on this invitation.' });
    expect((await household('The Sterns')).guests.every((g) => g.rsvp === 'pending')).toBe(true);
    for (const bad of ['', 'short', 'x'.repeat(43), `${token}x`, '../../etc/passwd']) expect(await readRsvp(bad, '203.0.113.9'), bad).toBeNull();
    await refused(showRsvpLink(c.slug, { id: (await household('The Okoros')).id }), /has not been invited yet/);
    // Only the hash and a sealed copy are stored.
    const row = await db.household.findFirstOrThrow({ where: { orgId: c.orgId, name: 'The Lindqvists' } });
    expect(row.rsvpTokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await tokenOf('The Lindqvists')).toBe(token); // the same link every time
  });

  it('is rate limited per address', async () => {
    const token = await tokenOf('The Lindqvists');
    for (let i = 0; i < 60; i++) await readRsvp(token, '198.51.100.7');
    expect(await readRsvp(token, '198.51.100.7')).toBe('limited');
    expect(await readRsvp(token, '198.51.100.8')).not.toBe('limited');
  });

  it('the couple can record a reply by hand; it is checked the same way and feeds the same delta', async () => {
    const ben = await guest('Ben Vale');
    await refused(recordRsvp(c.slug, { id: ben.id, rsvp: 'attending', meal: 'Lobster', songRequest: '' }), /Pick a meal for Ben Vale/);
    await ok(recordRsvp(c.slug, { id: ben.id, rsvp: 'attending', meal: 'Chicken', dietary: ['gluten_free'], accessibility: ['wheelchair'], songRequest: 'September' }));
    expect(await guest('Ben Vale')).toMatchObject({ rsvp: 'attending', meal: 'Chicken', dietary: ['gluten_free'], accessibility: ['wheelchair'] });
    await ok(recordRsvp(c.slug, { id: ben.id, rsvp: 'pending', meal: '', songRequest: '' }));
    expect(await guest('Ben Vale')).toMatchObject({ rsvp: 'pending', meal: null, respondedAt: null });
    expect((await db.headcountDelta.findMany({ where: { orgId: c.orgId }, orderBy: { at: 'asc' } })).map((d) => d.label)).toEqual(['Ben accepted', 'Ben has not answered']);
  });
});

describe('rule 3: the undetectability sweep on real responses (PRD P0-4)', () => {
  it('an A household and a B household get the same RSVP page and the same reminder, with nothing about waves in either', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    await decline('The Vales');
    await decline('The Sterns');
    goToDay(addDays(date, -300)); // the B wave goes out a month later
    await as(c.a); // a session does not outlive a jump of weeks
    await ok(releaseWave(c.slug, { list: 'B' }));
    const [a, b] = [await household('The Lindqvists'), await household('The Okoros')];
    expect([a.list, b.list]).toEqual(['A', 'B']);
    expect(dayOfDb(a.invitedOn!)).not.toBe(dayOfDb(b.invitedOn!));

    const [va, vb] = [await readRsvp(await tokenOf('The Lindqvists'), '203.0.113.9'), await readRsvp(await tokenOf('The Okoros'), '203.0.113.9')];
    const mask = (v: unknown) => JSON.stringify(v).replaceAll(/Lindqvists|Okoros|Lindqvist|Okoro|Linda|Omar|Chidi|Ngozi/g, 'N').replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'ID');
    expect(mask(vb)).toBe(mask(va));
    const keys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    expect(keys(va).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
    for (const leak of [dayOfDb(a.invitedOn!), dayOfDb(b.invitedOn!), a.createdAt.toISOString().slice(0, 10), a.waveId!, b.waveId!, a.id, b.id, c.orgId]) expect(`${JSON.stringify(va)}${JSON.stringify(vb)}`).not.toContain(leak);

    // The reminders both households get (captured in the outbox, never sent) are the same text too.
    const deadline = await withOrg({ orgId: c.orgId }, async (tx) => rsvpDeadline(tx, { orgId: c.orgId }, await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } })));
    goToDay(addDays(deadline, -14)); // 14 days before the RSVP deadline
    await as(c.a); // a session does not outlive a jump of weeks
    expect(addDays(today(), 14)).toBe(deadline);
    await ok(sendReminders(c.slug, {}));
    const mail = await db.outbox.findMany({ where: { orgId: c.orgId } });
    const body = (to: string) => mask((mail.find((m) => m.to === to)!.data as { body: string }).body.replace(/\/r\/[\w-]+/, '/r/TOKEN'));
    expect(body('chidi@okoro.example')).toBe(body('linda@lindqvist.example'));
    expect(mail.map((m) => JSON.stringify(m.data)).join('')).not.toMatch(/wave|list|priority|invited on/i);
    // The tokens themselves carry no order or time: 43 url-safe characters of randomness each.
    for (const name of ['The Lindqvists', 'The Okoros']) expect(await tokenOf(name)).toMatch(/^[\w-]{43}$/);
  });
});

describe('chasing (PRD P0-3): the worklist follows the derived deadline', () => {
  it('reminders go by the cadence, once each; the call list opens three days out; a called household leaves it', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    const chase = () => withOrg({ orgId: c.orgId }, (tx) => loadChase(tx, { orgId: c.orgId }));
    // No booked vendor asks for a count, so RSVPs are due 14 + 14 days before the wedding (D-44).
    expect((await chase()).deadline).toBe(addDays(date, -28));
    await refused(sendReminders(c.slug, {}), /No reminder is due today/);
    goToDay(addDays(date, -28 - 21)); // 21 days before the deadline
    await as(c.a); // a session does not outlive a jump of weeks
    expect((await chase()).daysLeft).toBe(21);
    expect((await chase()).plan).toEqual({ remind: expect.arrayContaining([expect.objectContaining({ step: 21 })]), call: [(await household('The Vales')).id] }); // the Vales have no email
    expect((await chase()).plan.remind).toHaveLength(3);
    await ok(sendReminders(c.slug, {}));
    await refused(sendReminders(c.slug, {}), /No reminder is due today/); // not twice
    expect(await db.outbox.count({ where: { orgId: c.orgId } })).toBe(3);
    expect((await db.outbox.findFirstOrThrow({ where: { orgId: c.orgId, to: 'linda@lindqvist.example' } })).data).toMatchObject({ subject: 'Please reply: Juniper & Rowan' });
    expect(await db.outbox.count({ where: { orgId: c.orgId, sentAt: { not: null } } })).toBe(0); // queued, not sent: no cron ran
    await decline('The Sterns'); // answered: off every list
    goToDay(addDays(date, -28 - 3)); // 3 days before
    await as(c.a); // a session does not outlive a jump of weeks
    const late = await chase();
    expect(late.plan.remind.map((r) => r.step)).toEqual([3, 3]);
    expect(late.plan.call).toHaveLength(3);
    await ok(markCalled(c.slug, { id: (await household('The Vales')).id }));
    await refused(markCalled(c.slug, { id: (await household('The Vales')).id }), /already marked as called/);
    expect((await chase()).plan.call).toHaveLength(2);
  });

  it('when a booked vendor asks for a count, the deadline is that vendor\'s date minus the chase buffer', async () => {
    await ok(addVendor(c.slug, { name: 'Fennel & Fig Catering', category: 'caterer', contactName: '', email: '', phone: '' }));
    const v = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } });
    await ok(updateVendor(c.slug, { id: v.id, name: v.name, category: 'caterer', contactName: '', email: '', phone: '', notes: '', deliverables: '', arrive: '', depart: '', countEstimate: '', countDueDaysBefore: '21', contractTotal: '' }));
    await ok(proposeBooking(c.slug, { id: v.id }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, status: 'pending' } })).id }));
    expect((await withOrg({ orgId: c.orgId }, (tx) => loadChase(tx, { orgId: c.orgId }))).deadline).toBe(addDays(date, -(21 + 14)));
  });
});

describe('guest-list removals are designated (PRD P0-2, rule 2)', () => {
  it('a removal is proposed, changes nothing, and happens when the partner approves; the seat is freed', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    const ada = await guest('Ada Stern'); // a child
    await ok(recordRsvp(c.slug, { id: ada.id, rsvp: 'attending', meal: '', songRequest: '' }));
    await ok(proposeGuestRemoval(c.slug, { id: ada.id }));
    await refused(proposeGuestRemoval(c.slug, { id: ada.id }), /already waiting/);
    expect((await guest('Ada Stern')).removedAt).toBeNull();
    const r = await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'remove_guest' } });
    await refused(approveRequest(c.slug, { id: r.id }), /your partner has to decide/);
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id }));
    expect(await guest('Ada Stern')).toMatchObject({ removedRequestId: r.id });
    expect((await guest('Ada Stern')).removedAt).not.toBeNull();
    expect((await state()).cap).toMatchObject({ held: 7, attending: 0, available: 1 });
    expect((await db.headcountDelta.findMany({ where: { orgId: c.orgId }, orderBy: { at: 'asc' } })).at(-1)).toMatchObject({ label: 'Ada removed', deltaSeats: -1, deltaCents: -3500 });
    // A removed guest is gone from their household's RSVP page and cannot be answered for.
    const view = await readRsvp(await tokenOf('The Sterns'), '203.0.113.9');
    expect((view as { guests: { name: string }[] }).guests.map((g) => g.name)).toEqual(['Ruth Stern']);
    await refused(recordRsvp(c.slug, { id: ada.id, rsvp: 'attending', meal: '', songRequest: '' }), /was removed/);
  });

  it('the rules are re-read after a removal: a spouse left alone on the invitation becomes entitled to a guest', async () => {
    await ok(saveGuestPlan(c.slug, { ...PLAN, cap: '9' }));
    await ok(releaseWave(c.slug, { list: 'A' }));
    await ok(proposeGuestRemoval(c.slug, { id: (await guest('Ben Vale')).id }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'remove_guest' } })).id }));
    expect((await state()).cap.held).toBe(8); // Ben's seat is gone, Cy (married, now the only adult named) holds one for a guest
  });

  it('the database refuses a removal without an approved request that names the guest, and any delete', async () => {
    const [ben, cy] = [await guest('Ben Vale'), await guest('Cy Vale')];
    const sql = (q: string) => db.$executeRawUnsafe(q);
    await expect(sql(`UPDATE "Guest" SET "removedAt" = now() WHERE id = '${ben.id}'`)).rejects.toThrow(/Guest_removed_check|two-key: removing a guest/);
    await ok(proposeGuestRemoval(c.slug, { id: ben.id }));
    const r = await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'remove_guest' } });
    await expect(sql(`UPDATE "Guest" SET "removedAt" = now(), "removedRequestId" = '${r.id}' WHERE id = '${ben.id}'`)).rejects.toThrow(/two-key: removing a guest needs an approved remove_guest request/); // pending
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id }));
    await expect(sql(`UPDATE "Guest" SET "removedAt" = now(), "removedRequestId" = '${r.id}' WHERE id = '${cy.id}'`)).rejects.toThrow(/that request is for another guest/);
    await expect(sql(`UPDATE "Guest" SET "removedAt" = NULL, "removedRequestId" = NULL WHERE id = '${ben.id}'`)).rejects.toThrow(/a removed guest stays removed/);
    await expect(sql(`DELETE FROM "Guest" WHERE id = '${cy.id}'`)).rejects.toThrow(/never deleted/);
    await expect(sql(`DELETE FROM "Household" WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/never deleted/);
    // The whole workspace can still be deleted: its guests go with it.
    await expect(sql(`DELETE FROM "Org" WHERE id = '${c.orgId}'`)).resolves.toBe(1);
    expect(await db.guest.count()).toBe(0);
  });
});

describe('vendor briefs get counts, never names (PRD P0-3, P0-7)', () => {
  it('the caterer sees meal and dietary counts; the DJ sees requests and the do-not-play list; neither sees a guest', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    const lind = await household('The Lindqvists');
    await submitRsvp(await tokenOf('The Lindqvists'), '203.0.113.9', { responses: [{ guestId: lind.guests[0]!.id, attending: true, meal: 'Fish', dietary: ['gluten_free'], accessibility: ['step_free'], songRequest: 'September' }, { guestId: lind.guests[1]!.id, attending: true, meal: 'Chicken', dietary: ['gluten_free', 'nut_allergy'], accessibility: [], songRequest: 'Dancing Queen' }], plusOneName: '' });
    await ok(addDoNotPlay(c.slug, { title: 'Macarena', artist: '' }));
    await refused(addDoNotPlay(c.slug, { title: 'Macarena', artist: '' }), /already on the list/);
    for (const [name, category] of [['Fennel & Fig Catering', 'caterer'], ['Tin Roof Strings', 'dj']] as const) await ok(addVendor(c.slug, { name, category, contactName: '', email: '', phone: '' }));
    const vendors = await db.vendor.findMany({ where: { orgId: c.orgId }, orderBy: { name: 'asc' } });
    for (const v of vendors) await ok(regenerateBrief(c.slug, { id: v.id }));
    const [caterer, dj] = await Promise.all(vendors.map((v) => db.vendorBrief.findFirstOrThrow({ where: { vendorId: v.id } })));
    expect(caterer!.body).toContain('- Confirmed so far: 2 attending (2 adults, 0 children, 0 infants)');
    expect(caterer!.body).toContain('- Adult meal choices: Chicken 1, Fish 1');
    expect(caterer!.body).toContain('- Dietary: gluten free 2, nut allergy 1');
    expect(caterer!.body).toContain('- Access: step free 1');
    expect(dj!.body).toContain('Requests:\n- Dancing Queen\n- September');
    expect(dj!.body).toContain('Do not play:\n- Macarena');
    expect(dj!.body).not.toContain('Dietary');
    const names = (await db.guest.findMany({ where: { orgId: c.orgId } })).flatMap((g) => g.name.split(' ')).concat((await db.household.findMany({ where: { orgId: c.orgId } })).map((h) => h.name));
    for (const n of new Set(names)) for (const b of [caterer!, dj!]) expect(b.body, n).not.toContain(n);
  });
});

describe('helpers and the guest list', () => {
  it('a helper needs the guest-list grant, and even with it cannot propose a removal', async () => {
    const h = await household('Sam Webb');
    await as(c.helper);
    await refused(addGuest(c.slug, { householdId: h.id, name: 'Jo Webb', ageGroup: 'adult', partnerStatus: 'none' }), /do not have access/);
    await refused(releaseWave(c.slug, { list: 'A' }), /do not have access/);
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'guests_edit' } });
    await ok(addGuest(c.slug, { householdId: h.id, name: 'Jo Webb', ageGroup: 'adult', partnerStatus: 'none' }));
    await refused(proposeGuestRemoval(c.slug, { id: (await guest('Jo Webb')).id }), /do not have access/);
  });
});

describe('change log: a scripted guest-list session covers every guest action', () => {
  it('every action leaves its entries, with who', async () => {
    const steps: [keyof typeof guestActions, () => Promise<Record<string, unknown>> | Record<string, unknown>, string[]][] = [
      ['saveGuestPlan', () => ({ ...PLAN, cap: '9' }), ['knotwork.guestplan.updated']],
      ['addHousehold', () => ({ name: 'The Nguyens', email: '', phone: '', address1: '', city: '', region: '', postal: '', list: 'B', priority: 20 }), ['knotwork.household.created']],
      ['importGuests', () => ({ csv: 'household,name\nThe Bells,Ira Bell\n', confirm: 'on' }), ['knotwork.household.imported']],
      ['updateHousehold', async () => ({ id: (await household('Sam Webb')).id, name: 'Sam Webb', email: 'sam@webb.example', phone: '', address1: '', city: '', region: '', postal: '', list: 'B', priority: 12, plusOneOverride: 'grant', plusOneNote: 'Sam asked' }), ['knotwork.household.updated']],
      ['addGuest', async () => ({ householdId: (await household('The Nguyens')).id, name: 'An Nguyen', ageGroup: 'adult', partnerStatus: 'none' }), ['knotwork.guest.created']],
      ['updateGuest', async () => ({ id: (await guest('An Nguyen')).id, name: 'An Nguyen', ageGroup: 'adult', partnerStatus: 'engaged', privateNote: 'cousin' }), ['knotwork.guest.updated']],
      ['markSaveTheDate', async () => ({ id: (await household('The Sterns')).id }), ['knotwork.household.updated']],
      ['releaseWave', () => ({ list: 'A' }), ['knotwork.wave.created']],
      ['recordRsvp', async () => ({ id: (await guest('Ben Vale')).id, rsvp: 'declined', meal: '', songRequest: '' }), ['knotwork.guest.updated']],
      ['newRsvpLink', async () => ({ id: (await household('The Sterns')).id }), ['knotwork.household.relinked']],
      ['proposeGuestRemoval', async () => ({ id: (await guest('Cy Vale')).id }), ['knotwork.request.proposed']],
      ['addDoNotPlay', () => ({ title: 'Macarena', artist: '' }), ['knotwork.song.created']],
      ['removeDoNotPlay', async () => ({ id: (await db.doNotPlay.findFirstOrThrow({ where: { orgId: c.orgId } })).id }), ['knotwork.song.deleted']],
    ];
    const noLog: (keyof typeof guestActions)[] = ['showRsvpLink']; // shows a link; changes nothing a person did
    const later: (keyof typeof guestActions)[] = ['sendReminders', 'markCalled', 'closeBList']; // need the clock moved; logged in the chase and lockout tests above
    expect([...steps.map((s) => s[0]), ...noLog, ...later].sort()).toEqual(Object.keys(guestActions).sort());
    let seen = (await log(c.orgId)).length;
    for (const [name, input, want] of steps) {
      await as(c.a);
      const o = await outcome((guestActions[name] as (slug: string, i: unknown) => Promise<unknown>)(c.slug, await input()));
      expect(o.error, `${name}: ${o.error}`).toBeUndefined();
      const all = await log(c.orgId);
      expect(all.slice(seen).map((e) => e.action), name).toEqual(want);
      for (const e of all.slice(seen)) {
        expect(e.actorUserId, name).toBe(c.a);
        expect(e.targetType, name).toBe(parseAction(e.action)!.entity);
      }
      seen = all.length;
    }
    expect([...new Set((await log(c.orgId)).map((e) => parseAction(e.action)!.entity))]).toEqual(expect.arrayContaining(['household', 'guest', 'wave', 'guestplan', 'song'])); // every guest-list entity
    const override = (await log(c.orgId)).find((e) => e.action === 'knotwork.household.updated' && (e.data as { after: { plusOneOverride?: string } }).after.plusOneOverride);
    expect(override!.data).toMatchObject({ before: { plusOneOverride: null, plusOneNote: '' }, after: { plusOneOverride: 'grant', plusOneNote: 'Sam asked' } }); // "per-household overrides logged"
  });

  it('a reply through the link is logged with no user: the feed shows it as the guest\'s own', async () => {
    await ok(releaseWave(c.slug, { list: 'A' }));
    await decline('The Vales');
    const e = (await log(c.orgId)).filter((x) => x.action === 'knotwork.guest.updated');
    expect(e).toHaveLength(2);
    for (const x of e) {
      expect(x.actorUserId).toBeNull();
      expect(x.data).toMatchObject({ via: 'rsvp-link', before: { rsvp: 'pending' }, after: { rsvp: 'declined' } });
    }
  });
});
void markSaveTheDate; void updateGuest; void addHousehold; void removeDoNotPlay;
