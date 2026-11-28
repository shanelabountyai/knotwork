import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cronJobs } from '@/app/cron-jobs';
import { createWedding } from '@/app/o/[org]/wedding/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { POST as stopRoute } from '@/app/r/[token]/stop/confirm/route';
import { advanceClock, now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { env } from '@/core/env';
import { drainOutbox } from '@/modules/notifications/outbox';
import { parseAction } from '@/lib/knotwork/changelog-diff';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { Refused } from '@/core/errors';
import { readRsvp, readStop, remindEach, RSVP_LIMIT, sendRemindersEverywhere, stopFromLink } from '@/lib/knotwork/guests/public';
import { loadChase, rsvpDeadline } from '@/lib/knotwork/guests/store';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';

const { importGuests, releaseWave, saveGuestPlan, sendReminders, setReminderChannel, showRsvpLink, updateHousehold } = guestActions;

// Phase 5 (D-134): Knotwork's sends made ready for the template's real transports, without sending anything. Reminders
// on a schedule as well as the button; a channel per household with consent; the opt-out on the household's own RSVP
// token; and the exact request each provider would receive when (fake) keys are set in this test only.
const today = () => todayIn('America/Chicago', now());
const IP = '203.0.113.44';
let c: Couple;
let date: string;

// Cap 8. A list: the Lindqvists, the Sterns, Priya; B list: the Okoros, Sam Webb. Every household has an email.
const CSV = `household,name,email,list,priority,age_group,partner_status
The Lindqvists,Linda Lindqvist,linda@lindqvist.example,A,1,adult,married
The Lindqvists,Omar Lindqvist,,A,1,adult,married
The Sterns,Ruth Stern,ruth@stern.example,A,2,adult,none
Priya Rao,Priya Rao,priya@rao.example,A,3,adult,none
The Okoros,Chidi Okoro,chidi@okoro.example,B,10,adult,married
The Okoros,Ngozi Okoro,,B,10,adult,married
Sam Webb,Sam Webb,sam@webb.example,B,11,adult,none
`;
const PLAN = { cap: '8', venueMin: '', venueMax: '', perHead: '0', kidsMeal: '0', vendorMeal: '0', lockoutDays: '42', minBatchSeats: '1', mealOptions: 'Chicken, Fish' };
const household = (name: string) => db.household.findFirstOrThrow({ where: { orgId: c.orgId, name } });
const tokenOf = async (name: string) => String(((await outcome(showRsvpLink(c.slug, { id: (await household(name)).id }))).result as { notice: string }).notice).split('/r/')[1]!;
const chase = () => withOrg({ orgId: c.orgId }, (tx) => loadChase(tx, { orgId: c.orgId }));
const deadline = async () => withOrg({ orgId: c.orgId }, async (tx) => rsvpDeadline(tx, { orgId: c.orgId }, await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } })));
const hhFields = (h: { name: string; email: string; phone: string; list: string; priority: number }) => ({ id: '', name: h.name, email: h.email, phone: h.phone, address1: '', city: '', region: '', postal: '', list: h.list, priority: String(h.priority), plusOneOverride: '', plusOneNote: '' });
const setPhone = async (name: string, phone: string) => {
  const h = await household(name);
  return outcome(updateHousehold(c.slug, { ...hhFields(h), id: h.id, phone }));
};
const stopPost = async (token: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }, ip = IP) => {
  const res = await stopRoute(new Request(`http://localhost:8400/r/${token}/stop/confirm`, { method: 'POST', headers: { 'x-forwarded-for': ip, ...headers } }), { params: Promise.resolve({ token }) });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
};
/** Two weeks before the RSVP deadline (midday in Chicago): the 14-day step is due. */
const toStep14 = async () => {
  goToDay(addDays(await deadline(), -14));
  await as(c.a); // a session does not outlive a jump of weeks
};

beforeEach(async () => {
  date = addDays(today(), 330);
  c = await makeWedding(date);
  await ok(saveGuestPlan(c.slug, PLAN));
  await ok(importGuests(c.slug, { csv: CSV, confirm: 'on' }));
  await ok(releaseWave(c.slug, { list: 'A' }));
  await ok(releaseWave(c.slug, { list: 'B' }));
});

describe('a channel per household, with consent', () => {
  it('email is the default; text messages need a phone in international form and a consent date; none means the couple calls', async () => {
    const priya = await household('Priya Rao');
    expect(priya).toMatchObject({ remindVia: 'email', smsConsentOn: null, remindersStoppedAt: null });
    await refused(setReminderChannel(c.slug, { id: priya.id, channel: 'sms', smsConsentOn: addDays(today(), -1) }), /international form/);
    expect((await setPhone('Priya Rao', '+15550100123')).nav).toBe('redirect');
    await refused(setReminderChannel(c.slug, { id: priya.id, channel: 'sms', smsConsentOn: '' }), /day Priya Rao agreed/);
    await refused(setReminderChannel(c.slug, { id: priya.id, channel: 'sms', smsConsentOn: addDays(today(), 1) }), /cannot be in the future/);
    await refused(setReminderChannel(c.slug, { id: priya.id, channel: 'sms', smsConsentOn: '2027-02-30' }), /real date/);
    await ok(setReminderChannel(c.slug, { id: priya.id, channel: 'sms', smsConsentOn: addDays(today(), -1) }));
    expect(await household('Priya Rao')).toMatchObject({ remindVia: 'sms' });
    await refused(setReminderChannel(c.slug, { id: priya.id, channel: 'sms', smsConsentOn: addDays(today(), -1) }), /Nothing changed/);
    // The phone cannot be cleared or garbled while texts are the channel.
    expect((await setPhone('Priya Rao', '')).error).toMatch(/get reminders by text message/);
    expect((await setPhone('Priya Rao', '555 0100')).error).toMatch(/international form/);
    // D-153: the consent was given at this number; another valid number does not inherit it.
    const consentedAt = (await household('Priya Rao')).phone;
    expect((await setPhone('Priya Rao', '+15559990000')).error).toMatch(/agreed to text reminders at their current number/);
    expect(await household('Priya Rao')).toMatchObject({ phone: consentedAt, remindVia: 'sms' });
    expect((await setPhone('Priya Rao', consentedAt)).error).toBeUndefined(); // saving the same number is still fine
    // Back to email: the consent date is cleared with it.
    await ok(setReminderChannel(c.slug, { id: priya.id, channel: 'email', smsConsentOn: '' }));
    expect(await household('Priya Rao')).toMatchObject({ remindVia: 'email', smsConsentOn: null });
    const entries = (await log(c.orgId)).filter((e) => e.targetId === priya.id && e.action === 'knotwork.household.updated').map((e) => (e.data as { after: object }).after);
    expect(entries.slice(-2)).toEqual([{ remindVia: 'sms', smsConsentOn: addDays(today(), -1) }, { remindVia: 'email', smsConsentOn: null }]);
    await refused(setReminderChannel(c.slug, { id: (await household('The Okoros')).id, channel: 'email', smsConsentOn: '' }), /Nothing changed/);
  });

  it('the database refuses a text-message channel without a consent date or a phone', async () => {
    const h = await household('Sam Webb');
    await expect(db.household.update({ where: { id: h.id }, data: { remindVia: 'sms' } })).rejects.toThrow(/Household_sms_consent_check/);
    await expect(db.household.update({ where: { id: h.id }, data: { remindVia: 'sms', smsConsentOn: new Date('2026-01-01') } })).rejects.toThrow(/Household_sms_consent_check/);
  });

  it('a helper without the guest grant cannot change it; another workspace\'s household is not found', async () => {
    const sam = await household('Sam Webb');
    await as(c.helper);
    await refused(setReminderChannel(c.slug, { id: sam.id, channel: 'none', smsConsentOn: '' }), /You do not have access to that/);
    const other = await makeOrg('sage-and-wren');
    await as((await addMember(other.id, 'owner', 'sage@example.test')).id);
    await ok(createWedding(other.slug, { title: 'Sage & Wren', date, timeZone: 'America/Chicago' }));
    expect((await outcome(setReminderChannel(other.slug, { id: sam.id, channel: 'none', smsConsentOn: '' }))).nav).toBe('notFound');
  });

  it('reminders go on each household\'s channel; none and unreachable households go to the call list early', async () => {
    await setPhone('Priya Rao', '+15550100123');
    await ok(setReminderChannel(c.slug, { id: (await household('Priya Rao')).id, channel: 'sms', smsConsentOn: addDays(today(), -3) }));
    await ok(setReminderChannel(c.slug, { id: (await household('Sam Webb')).id, channel: 'none', smsConsentOn: '' }));
    await toStep14();
    const plan = (await chase()).plan;
    expect(plan.remind).toHaveLength(4);
    expect(plan.call).toEqual([(await household('Sam Webb')).id]);
    await ok(sendReminders(c.slug, {}));
    const out = await db.outbox.findMany({ where: { orgId: c.orgId }, orderBy: { to: 'asc' } });
    expect(out.map((m) => [m.channel, m.to])).toEqual([['sms', '+15550100123'], ['email', 'chidi@okoro.example'], ['email', 'linda@lindqvist.example'], ['email', 'ruth@stern.example']]);
    const sms = out[0]!.data as { subject: string; body: string };
    expect(sms.body).toMatch(/^Juniper & Rowan: please reply by .+: http:\/\/localhost:8400\/r\/[\w-]{43}\nStop reminders: http:\/\/localhost:8400\/r\/[\w-]{43}\/stop$/);
    expect(sms.body).not.toContain('Priya'); // a text message carries no name
    const reminded = (await log(c.orgId)).filter((e) => e.action === 'knotwork.household.reminded').map((e) => (e.data as { after: object }).after);
    expect(reminded).toEqual([{ households: 4, step: 14, email: 3, sms: 1 }]);
  });
});

describe('the opt-out link: the household\'s own RSVP token, at once', () => {
  it('every reminder carries it; one post stops further reminders at once, and the household goes to the call list', async () => {
    await toStep14();
    await ok(sendReminders(c.slug, {}));
    const token = await tokenOf('The Okoros');
    const mail = await db.outbox.findFirstOrThrow({ where: { orgId: c.orgId, to: 'chidi@okoro.example' } });
    expect((mail.data as { body: string }).body).toContain(`To stop these reminders: http://localhost:8400/r/${token}/stop`);
    expect(await readStop(token, IP)).toEqual({ weddingTitle: 'Juniper & Rowan' });
    expect(await stopPost(token)).toEqual({ status: 303, location: `/r/${token}/stop?done=1`, text: '' });
    expect((await household('The Okoros')).remindersStoppedAt).not.toBeNull();
    // A second stop changes nothing and answers the same.
    const before = await snapshot();
    expect(await stopPost(token)).toMatchObject({ status: 303, location: `/r/${token}/stop?done=1` });
    expect(await snapshot()).toBe(before);
    // The next step goes to everyone still waiting except them; they are on the call list instead.
    goToDay(addDays(await deadline(), -7));
    await as(c.a);
    const plan = (await chase()).plan;
    expect(plan.remind.map((r) => r.id)).not.toContain((await household('The Okoros')).id);
    expect(plan.call).toContain((await household('The Okoros')).id);
    await ok(sendReminders(c.slug, {}));
    expect(await db.outbox.count({ where: { orgId: c.orgId, to: 'chidi@okoro.example' } })).toBe(1);
    // The couple cannot switch them back on.
    await refused(setReminderChannel(c.slug, { id: (await household('The Okoros')).id, channel: 'none', smsConsentOn: '' }), /stopped reminders/);
    // Logged, by the link, with no token.
    const entry = (await log(c.orgId)).find((e) => e.action === 'knotwork.household.optedout')!;
    expect(entry).toMatchObject({ actorUserId: null, data: { label: 'The Okoros', via: 'rsvp-link', after: { reminders: false } } });
    expect(parseAction(entry.action)!.text).toBe('stopped reminders (from their own link) for');
    expect(JSON.stringify(entry.data)).not.toContain(token);
    // Their RSVP link still works.
    expect(await readRsvp(token, IP)).toMatchObject({ householdName: 'The Okoros' });
  });

  it('rule 3: an A household and a B household see the same page and get the same answer; every link that does not work is the same 404', async () => {
    const [a, b] = [await tokenOf('The Lindqvists'), await tokenOf('The Okoros')];
    expect([(await household('The Lindqvists')).list, (await household('The Okoros')).list]).toEqual(['A', 'B']);
    expect(await readStop(b, IP)).toEqual(await readStop(a, IP));
    const mask = (r: { location: string | null }, t: string) => JSON.stringify(r).replace(t, 'TOKEN');
    expect(mask(await stopPost(b), b)).toBe(mask(await stopPost(a), a));
    // Unknown, malformed and never-invited links: one 404, from the page and from the post alike.
    await ok(importGuests(c.slug, { csv: 'household,name,email,list,priority,age_group,partner_status\nThe Quinns,Ann Quinn,ann@quinn.example,B,20,adult,none\n', confirm: 'on' }));
    expect((await household('The Quinns')).state).toBe('queued');
    for (const bad of ['x'.repeat(43), 'short', '../../etc', `${a}x`]) {
      expect(await readStop(bad, IP), bad).toBeNull();
      expect(await stopFromLink(bad, IP), bad).toBeNull();
      expect(await stopPost(bad), bad).toEqual({ status: 404, location: null, text: 'Not found' });
    }
    expect(await db.household.count({ where: { orgId: c.orgId, remindersStoppedAt: { not: null } } })).toBe(2);
  });

  it('a cross-site post is refused like a missing link and changes nothing', async () => {
    const token = await tokenOf('The Sterns');
    const before = await snapshot();
    expect(await stopPost(token, { 'sec-fetch-site': 'cross-site' })).toEqual({ status: 404, location: null, text: 'Not found' });
    expect(await stopPost(token, { origin: 'https://evil.example' })).toEqual({ status: 404, location: null, text: 'Not found' });
    expect(await snapshot()).toBe(before);
  });

  it('shares the RSVP pages\' rate limit, per address, checked before the token is looked at', async () => {
    const token = await tokenOf('The Sterns');
    const ip = '198.51.100.77';
    for (let i = 0; i < RSVP_LIMIT.limit - 1; i++) expect(await readRsvp(token, ip)).not.toBe('limited');
    expect(await readStop(token, ip)).toEqual({ weddingTitle: 'Juniper & Rowan' }); // the 60th, on the stop page
    expect(await readStop(token, ip)).toBe('limited');
    expect(await readRsvp(token, ip)).toBe('limited');
    expect(await stopPost(token, { 'sec-fetch-site': 'same-origin' }, ip)).toMatchObject({ status: 429 });
    expect(await stopPost('x'.repeat(43), { 'sec-fetch-site': 'same-origin' }, ip)).toMatchObject({ status: 429 }); // the same answer for a bad link
    expect((await household('The Sterns')).remindersStoppedAt).toBeNull();
  });
});

describe('reminders on a schedule (cron) as well as the button', () => {
  it('D-153: one workspace that errors neither stops the others nor throws out of the cron run', async () => {
    const seen: string[] = [];
    const out = await remindEach(['a', 'b', 'c', 'd'], async (orgId) => {
      seen.push(orgId);
      if (orgId === 'b') throw new Error('boom');
      if (orgId === 'c') throw new Refused('saved links cannot be read');
      return 2;
    });
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(out).toEqual({ orgs: 4, reminded: 4, skipped: 1, failed: 1 });
  });

  it('only where the couple turned it on; the same cadence; never one step twice, whichever runs first', async () => {
    await toStep14();
    expect(await sendRemindersEverywhere()).toMatchObject({ reminded: 0 }); // off by default
    expect(await db.outbox.count({ where: { orgId: c.orgId } })).toBe(0);
    await ok(saveGuestPlan(c.slug, { ...PLAN, autoReminders: 'on' }));
    expect((await db.guestPlan.findUniqueOrThrow({ where: { orgId: c.orgId } })).autoReminders).toBe(true);
    expect(await sendRemindersEverywhere()).toMatchObject({ reminded: 5, skipped: 0 });
    expect(await db.outbox.count({ where: { orgId: c.orgId } })).toBe(5);
    expect(await sendRemindersEverywhere()).toMatchObject({ reminded: 0 }); // the same day again: nothing
    await refused(sendReminders(c.slug, {}), /No reminder is due today/); // and the button finds nothing either
    const entry = (await log(c.orgId)).find((e) => e.action === 'knotwork.household.reminded')!;
    expect(entry).toMatchObject({ actorUserId: null, data: { via: 'schedule' } });
    expect(await db.chaseEvent.count({ where: { orgId: c.orgId, kind: 'reminder', byId: null } })).toBe(5);
    // The next step: the button first, then the schedule finds nothing.
    goToDay(addDays(await deadline(), -7));
    await as(c.a);
    await ok(sendReminders(c.slug, {}));
    expect(await sendRemindersEverywhere()).toMatchObject({ reminded: 0 });
    expect(await db.outbox.count({ where: { orgId: c.orgId } })).toBe(10);
  });

  it('the schedule sends no text message in quiet hours (wedding time); it stays due and goes on a run inside them', async () => {
    await setPhone('Priya Rao', '+15550100123');
    await ok(setReminderChannel(c.slug, { id: (await household('Priya Rao')).id, channel: 'sms', smsConsentOn: addDays(today(), -3) }));
    await ok(saveGuestPlan(c.slug, { ...PLAN, autoReminders: 'on' }));
    const day = addDays(await deadline(), -14);
    const at = (utc: string) => advanceClock(Date.parse(`${day}T${utc}Z`) - Date.now()); // advanceClock sets the offset
    at('06:00:00'); // midnight or 1 am in Chicago, when the daily cron fires
    expect(await sendRemindersEverywhere()).toMatchObject({ reminded: 4 }); // the emails
    expect(await db.outbox.count({ where: { orgId: c.orgId, channel: 'sms' } })).toBe(0);
    expect((await chase()).plan.remind.map((r) => r.id)).toEqual([(await household('Priya Rao')).id]); // still due
    at('15:00:00'); // mid-morning in Chicago
    expect(await sendRemindersEverywhere()).toMatchObject({ reminded: 1 });
    expect(await db.outbox.count({ where: { orgId: c.orgId, channel: 'sms' } })).toBe(1);
  });

  it('runs from the cron hook, before the outbox drain', async () => {
    await ok(saveGuestPlan(c.slug, { ...PLAN, autoReminders: 'on' }));
    await toStep14();
    await db.outbox.deleteMany({ where: { orgId: { not: c.orgId } } });
    const jobs = await cronJobs();
    expect(jobs.rsvpReminders).toMatchObject({ reminded: 5 });
    expect(jobs.outbox).toMatchObject({ sent: 5, failed: 0 }); // drained in the same run (captured: not production)
    expect(await db.capturedMessage.count({ where: { to: 'linda@lindqvist.example' } })).toBe(1);
  });
});

// The drain against a stubbed fetch, with fake keys injected into this test's environment only (the env object is
// restored after each test). Nothing leaves the process: fetch is a stub that records what it was asked.
describe('what each provider would receive (fetch stubbed, fake keys)', () => {
  const saved = { ...env };
  const KEYS = { RESEND_API_KEY: 're_test_fake_key_0000', EMAIL_FROM: 'Knotwork <reminders@knotwork.example>', TWILIO_ACCOUNT_SID: 'ACtestfake0000000000000000000000', TWILIO_AUTH_TOKEN: 'twilio_test_fake_token', TWILIO_FROM: '+15550001111' };
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const redact = (h: Record<string, string>) => ({ ...h, authorization: h.authorization?.replace(/^(Bearer|Basic) .+$/, '$1 [redacted]') });
  beforeEach(async () => {
    calls.length = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
      return new Response('{"id":"fake"}', { status: 200 });
    });
    await setPhone('Priya Rao', '+15550100123');
    await ok(setReminderChannel(c.slug, { id: (await household('Priya Rao')).id, channel: 'sms', smsConsentOn: addDays(today(), -3) }));
    await toStep14();
    await ok(sendReminders(c.slug, {}));
    await db.outbox.deleteMany({ where: { orgId: { not: c.orgId } } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(env) as (keyof typeof env)[]) if (!(k in saved)) delete env[k];
    Object.assign(env, saved);
  });

  it('with keys set in production: one Resend request per email and one Twilio request per text, in the providers\' own shapes', async () => {
    Object.assign(env, { VERCEL_ENV: 'production', ...KEYS });
    expect(await drainOutbox()).toEqual({ sent: 5, failed: 0 });
    const email = calls.filter((x) => x.url === 'https://api.resend.com/emails');
    const sms = calls.filter((x) => x.url.startsWith('https://api.twilio.com/'));
    expect([email.length, sms.length, calls.length]).toEqual([4, 1, 5]);
    const linda = email.find((x) => JSON.parse(x.body).to === 'linda@lindqvist.example')!;
    expect({ ...linda, headers: redact(linda.headers), body: JSON.parse(linda.body) }).toEqual({
      url: 'https://api.resend.com/emails', method: 'POST',
      headers: { authorization: 'Bearer [redacted]', 'content-type': 'application/json' },
      body: { from: KEYS.EMAIL_FROM, to: 'linda@lindqvist.example', subject: 'Please reply: Juniper & Rowan', text: expect.stringMatching(/^Dear The Lindqvists,\n\n[\s\S]+\nTo stop these reminders: http:\/\/localhost:8400\/r\/[\w-]{43}\/stop$/) },
    });
    expect(linda.headers.authorization).toBe(`Bearer ${KEYS.RESEND_API_KEY}`); // the real header carries the key; the assertion above does not print it
    const text = sms[0]!;
    expect({ ...text, headers: redact(text.headers), body: Object.fromEntries(new URLSearchParams(text.body)) }).toEqual({
      url: `https://api.twilio.com/2010-04-01/Accounts/${KEYS.TWILIO_ACCOUNT_SID}/Messages.json`, method: 'POST',
      headers: { authorization: 'Basic [redacted]', 'content-type': 'application/x-www-form-urlencoded' },
      body: { To: '+15550100123', From: KEYS.TWILIO_FROM, Body: expect.stringMatching(/^Juniper & Rowan: please reply by .+\nStop reminders: http:\/\/localhost:8400\/r\/[\w-]{43}\/stop$/) },
    });
    expect(text.headers.authorization).toBe(`Basic ${Buffer.from(`${KEYS.TWILIO_ACCOUNT_SID}:${KEYS.TWILIO_AUTH_TOKEN}`).toString('base64')}`);
    expect(await db.outbox.count({ where: { orgId: c.orgId, sentAt: null } })).toBe(0);
    // No body carries a wave signal.
    expect(calls.map((x) => x.body).join('\n')).not.toMatch(/wave|\blist\b|priority|invited on/i);
  });

  it('with the keys unset in production: nothing is sent, nothing crashes, each row waits with its error for a retry', async () => {
    Object.assign(env, { VERCEL_ENV: 'production' });
    for (const k of Object.keys(KEYS)) delete env[k as keyof typeof env];
    expect(await drainOutbox()).toEqual({ sent: 0, failed: 5 });
    expect(calls).toEqual([]);
    const rows = await db.outbox.findMany({ where: { orgId: c.orgId } });
    expect(rows.map((r) => [r.channel, r.sentAt, r.lastError]).sort()).toEqual([
      ['email', null, 'Email provider is not configured'], ['email', null, 'Email provider is not configured'], ['email', null, 'Email provider is not configured'], ['email', null, 'Email provider is not configured'],
      ['sms', null, 'SMS provider is not configured'],
    ]);
  });

  it('outside production (here, the demo, a preview): captured, never sent, whatever keys are set', async () => {
    Object.assign(env, { VERCEL_ENV: undefined, EMAIL_SANDBOX_TO: undefined, SMS_SANDBOX_TO: undefined, ...KEYS });
    expect(await drainOutbox()).toEqual({ sent: 5, failed: 0 });
    expect(calls).toEqual([]);
    expect(await db.capturedMessage.count({ where: { to: { in: ['linda@lindqvist.example', '+15550100123'] } } })).toBe(2);
  });
});
