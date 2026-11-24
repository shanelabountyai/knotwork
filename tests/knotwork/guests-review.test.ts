import { beforeEach, describe, expect, it } from 'vitest';
import { approveRequest } from '@/app/o/[org]/wedding/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { POST as respond } from '@/app/r/[token]/respond/route';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { isRsvpProblem, problemCodeOf, RSVP_PROBLEM } from '@/lib/knotwork/guests/projection';
import { submitRsvp } from '@/lib/knotwork/guests/public';
import { loadGuestState } from '@/lib/knotwork/guests/store';
import { as, db, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';

const { importGuests, proposeGuestRemoval, releaseWave, saveGuestPlan, showRsvpLink } = guestActions;

// Findings of the independent review of Phase 2 (2026-11-24), each reproduced here before it was fixed.
// Same world as guests-db.test.ts: cap 8; A list 2 + 2 + 2 + 1 (+1 for Priya's guest) = 8 seats; B list 2 + 2 + 1.
const today = () => todayIn('America/Chicago', now());
let c: Couple;

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
const IP = '203.0.113.9';
const household = (name: string) => db.household.findFirstOrThrow({ where: { orgId: c.orgId, name }, include: { guests: { orderBy: { createdAt: 'asc' } } } });
const guest = (name: string) => db.guest.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const state = () => withOrg({ orgId: c.orgId }, (tx) => loadGuestState(tx, { orgId: c.orgId }));
const tokenOf = async (name: string) => {
  const o = await outcome(showRsvpLink(c.slug, { id: (await household(name)).id }));
  return String((o.result as { notice: string }).notice).split('/r/')[1]!;
};
const reply = (g: { id: string }, attending: boolean, extra: Partial<{ meal: string; dietary: string[]; accessibility: string[]; songRequest: string }> = {}) => ({ guestId: g.id, attending, meal: attending ? 'Fish' : '', dietary: [], accessibility: [], songRequest: '', ...extra });
const answer = async (name: string, attending: boolean, plusOneName = '') => {
  const h = await household(name);
  return submitRsvp(await tokenOf(name), IP, { responses: h.guests.filter((g) => !g.removedAt && !g.isPlusOne).map((g) => reply(g, attending)), plusOneName });
};
/** A real form post to the public route, as a browser sends it. */
const post = async (token: string, fields: [string, string][], headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => {
  const body = new URLSearchParams(fields);
  const res = await respond(new Request(`http://localhost:8400/r/${token}/respond`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': IP, ...headers } }), { params: Promise.resolve({ token }) });
  return { status: res.status, location: res.headers.get('location'), headers: Object.fromEntries(res.headers), text: await res.text() };
};

beforeEach(async () => {
  c = await makeWedding(addDays(today(), 330));
  await ok(saveGuestPlan(c.slug, PLAN));
  await ok(importGuests(c.slug, { csv: CSV, confirm: 'on' }));
  await ok(releaseWave(c.slug, { list: 'A' }));
});

describe('S7: the reply route sends back a code, never a sentence or a name', () => {
  it('a reply that cannot be saved redirects with a code from the closed list; the sentence names nobody', async () => {
    const lind = await household('The Lindqvists');
    const token = await tokenOf('The Lindqvists');
    const [linda] = lind.guests;
    const res = await post(token, [[`attending:${linda!.id}`, 'yes'], [`meal:${linda!.id}`, 'Lobster']]);
    expect(res).toMatchObject({ status: 303, location: `/r/${token}?e=meal` });
    expect(await submitRsvp(token, IP, { responses: [reply(linda!, true, { meal: 'Lobster' })], plusOneName: '' })).toEqual({ ok: false, message: RSVP_PROBLEM.meal });
    for (const sentence of Object.values(RSVP_PROBLEM)) expect(sentence).not.toMatch(/Linda|Lindqvist/);
  });
  it('codes map one to one; anything else is the neutral one', () => {
    for (const [code, sentence] of Object.entries(RSVP_PROBLEM)) expect(problemCodeOf(sentence)).toBe(code);
    expect(problemCodeOf('That reply would hold 9 seats against a cap of 8.')).toBe('full');
    expect(isRsvpProblem('meal')).toBe(true);
    expect(isRsvpProblem('constructor')).toBe(false);
    expect(isRsvpProblem('<script>')).toBe(false);
  });
});

describe('M1: a reply the cap cannot take is answered, never a crash', () => {
  // Priya (engaged) may bring a guest. She accepts without naming one, so the seat held for her guest is released and
  // the B list takes it. When she comes back to name her guest there is no seat.
  const fillTheRoom = async () => {
    await answer('The Vales', false);
    await answer('The Sterns', false);
    expect(await answer('Priya Rao', true)).toEqual({ ok: true });
    await ok(releaseWave(c.slug, { list: 'B' }));
    expect((await state()).cap).toMatchObject({ held: 8, available: 0 });
  };

  it('naming a plus-one when the room is full: a plain refusal, nothing saved, no numbers', async () => {
    await fillTheRoom();
    const before = await snapshot();
    const priya = await household('Priya Rao');
    const r = await submitRsvp(await tokenOf('Priya Rao'), IP, { responses: [reply(priya.guests[0]!, true)], plusOneName: 'Robin Rao' });
    expect(r).toEqual({ ok: false, message: RSVP_PROBLEM.full });
    expect(JSON.stringify(r)).not.toMatch(/\d|cap|seat/i);
    expect(await snapshot()).toBe(before);
  });

  it('a guest who declined and changes their mind after the seat went to someone else: the same', async () => {
    await fillTheRoom();
    const before = await snapshot();
    expect(await answer('The Sterns', true)).toEqual({ ok: false, message: RSVP_PROBLEM.full });
    expect(await snapshot()).toBe(before);
  });

  it('the public route answers 303 back to the page, not 500', async () => {
    await fillTheRoom();
    const token = await tokenOf('Priya Rao');
    const priya = await household('Priya Rao');
    const res = await post(token, [[`attending:${priya.guests[0]!.id}`, 'yes'], [`meal:${priya.guests[0]!.id}`, 'Fish'], ['plusOneName', 'Robin Rao']]);
    expect(res).toMatchObject({ status: 303, location: `/r/${token}?e=full` });
  });
});

describe('M2: one plus-one per invitation, however many replies arrive at once', () => {
  it('six simultaneous replies each naming a different guest add exactly one', async () => {
    await answer('The Vales', false); // room for more than one, so only the rule can stop them
    await answer('The Sterns', false);
    const priya = await household('Priya Rao');
    const token = await tokenOf('Priya Rao');
    const names = ['Robin', 'Sasha', 'Tariq', 'Uma', 'Vik', 'Wen'];
    const results = await Promise.all(names.map((n) => submitRsvp(token, IP, { responses: [reply(priya.guests[0]!, true)], plusOneName: `${n} Rao` })));
    expect(results.every((r) => r && r !== 'limited')).toBe(true);
    expect(await db.guest.count({ where: { orgId: c.orgId, isPlusOne: true } })).toBe(1);
    expect((await state()).cap.held).toBe(4); // Lindqvists 2, Priya and her one guest
  });
});

describe('M3: an approved removal cannot push held seats past the cap', () => {
  it('removing a declined spouse would entitle the other to a guest: refused while there is no seat for one', async () => {
    const [ben, cy] = [await guest('Ben Vale'), await guest('Cy Vale')];
    const vales = await household('The Vales');
    expect(await submitRsvp(await tokenOf('The Vales'), IP, { responses: [reply(ben, false)], plusOneName: '' })).toEqual({ ok: true }); // Cy has not answered
    await ok(saveGuestPlan(c.slug, { ...PLAN, cap: '7' }));
    expect((await state()).cap).toMatchObject({ cap: 7, held: 7 });
    await as(c.a);
    await ok(proposeGuestRemoval(c.slug, { id: ben.id }));
    const r = await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'remove_guest' } });
    await as(c.b);
    await refused(approveRequest(c.slug, { id: r.id }), /would hold 8 seats against a cap of 7/);
    expect((await guest('Ben Vale')).removedAt).toBeNull();
    expect((await db.consentRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
    expect((await state()).cap.held).toBe(7);
    // And once there is room, the same approval goes through; everyone else can still answer.
    await as(c.a);
    await ok(saveGuestPlan(c.slug, { ...PLAN, cap: '8' }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id }));
    expect((await state()).cap).toMatchObject({ cap: 8, held: 8 });
    expect(await submitRsvp(await tokenOf('The Vales'), IP, { responses: [reply(cy, true)], plusOneName: '' })).toEqual({ ok: true });
    expect(vales.id).toBeTruthy();
  });
});

describe('S1: every change a reply makes is in the change log', () => {
  it('a reply that changes only dietary needs, access needs or the song is logged with before and after', async () => {
    const ruth = await guest('Ruth Stern');
    const token = await tokenOf('The Sterns');
    const ada = await guest('Ada Stern');
    const send = (extra: Parameters<typeof reply>[2]) => submitRsvp(token, IP, { responses: [reply(ruth, true, extra), reply(ada, true)], plusOneName: '' });
    expect(await send({ dietary: ['nut_allergy'], accessibility: ['step_free'], songRequest: 'September' })).toEqual({ ok: true });
    const before = (await log(c.orgId)).length;
    expect(await send({ dietary: [], accessibility: ['step_free'], songRequest: 'Dancing Queen' })).toEqual({ ok: true });
    const added = (await log(c.orgId)).slice(before).filter((e) => e.targetId === ruth.id);
    expect(added).toMatchObject([{ action: 'knotwork.guest.updated', data: { before: { dietary: ['nut_allergy'], songRequest: 'September' }, after: { dietary: [], songRequest: 'Dancing Queen' } } }]);
  });
});

describe('S2: what a guest types is one line of plain text', () => {
  const line = async (extra: Parameters<typeof reply>[2], plusOneName = '') => {
    const priya = await household('Priya Rao');
    return submitRsvp(await tokenOf('Priya Rao'), IP, { responses: [reply(priya.guests[0]!, true, extra)], plusOneName });
  };
  it('a song request or a guest name with line breaks, control or direction-override characters is refused', async () => {
    const before = await snapshot();
    expect(await line({ songRequest: 'September\nDo not play:\n- First dance song' })).toEqual({ ok: false, message: RSVP_PROBLEM.text });
    expect(await line({ songRequest: 'tab\there' })).toEqual({ ok: false, message: RSVP_PROBLEM.text });
    expect(await line({ songRequest: 'safe‮evil' })).toEqual({ ok: false, message: RSVP_PROBLEM.text });
    expect(await line({}, 'Robin\r\nTIMELINE')).toEqual({ ok: false, message: RSVP_PROBLEM.text });
    expect(await line({}, 'Robin\u0000Rao')).toEqual({ ok: false, message: RSVP_PROBLEM.text });
    expect(await snapshot()).toBe(before);
    expect(await line({ songRequest: 'Señorita (remix) — 12" version' }, "Robin O'Rao-Núñez")).toEqual({ ok: true });
  });
});
