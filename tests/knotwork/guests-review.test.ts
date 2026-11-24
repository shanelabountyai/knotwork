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
