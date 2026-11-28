import { beforeEach, describe, expect, it } from 'vitest';
import { addCategory, addExpense, addTask, addVendor, approveRequest, createWedding, declineRequest, proposeBooking, proposeSettings, setTaskStatus, updateTask } from '@/app/o/[org]/wedding/actions';
import { createContingencyPlan } from '@/app/o/[org]/wedding/contingency/actions';
import { logReceivedGift } from '@/app/o/[org]/wedding/gifts/actions';
import { importGuests, releaseWave, saveGuestPlan, sendReminders, showRsvpLink } from '@/app/o/[org]/wedding/guests/actions';
import { householdTask, proposeMode } from '@/app/o/[org]/wedding/life/actions';
import { startNameChange } from '@/app/o/[org]/wedding/name-change/actions';
import { createPhotoEvent } from '@/app/o/[org]/wedding/photos/actions';
import { POST as attachRoute } from '@/app/o/[org]/wedding/vendors/[id]/attachments/route';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { ARCHIVE_REFUSAL } from '@/lib/knotwork/access';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { readRsvp, submitRsvp } from '@/lib/knotwork/guests/public';
import { sendDueReminders } from '@/lib/knotwork/guests/store';
import { resetAuthTables } from '../helpers/auth';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, type Couple } from './db';
import { NOT_FOUND, PAGES, render } from './render';
import { fixture, multipart } from './uploads';

// Phase 5, slice F: the couple's life-admin mode, through the real actions, pages and routes. The switch is designated
// (rule 2: proposed here, made by consent/execute.ts on the second key, or solo; the database refuses any other writer).
// In life-admin mode the plan is a read-only archive (every write to it refused with one sentence), the home page is
// the couple's dashboard, household tasks recur by a rule (rule 1: the due day is computed, never stored), helpers keep
// only the album, secrecy holds on every page (the sweep below renders them all, by glob), and the guest's RSVP link
// takes no reply.
const HOST = 'localhost:8400';
const IP = '203.0.113.71';
const today = () => todayIn('America/Chicago', now());
const SECRET = 'ZQL';
const MODE = /The wedding plan is an archive now, read-only in life-admin mode\. Switch back to planning mode/;
let c: Couple;
let date: string;

const wedding = () => db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } });
const page = (file: string) => `src/app/o/[org]/${file}`;
const show = async (file: string, params: Record<string, string> = {}) => render(await PAGES[page(file)]!(), { org: c.slug, ...params });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const pending = (kind = 'set_mode') => db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: kind as never, status: 'pending' } });

/** The day after the wedding, signed in again as Juniper (the clock moved). */
async function afterTheWedding(days = 1) {
  goToDay(addDays(date, days));
  await as(c.a);
}
/** Juniper proposes, Rowan approves: the workspace is in life-admin mode. */
async function switchTo(to: 'life' | 'planning') {
  await as(c.a);
  await ok(proposeMode(c.slug, { to }));
  await as(c.b);
  await ok(approveRequest(c.slug, { id: (await pending()).id, fingerprint: '' }));
  await as(c.a);
}
const task = (op: string, rest: Record<string, unknown> = {}) => householdTask(c.slug, { op, id: '', title: '', unit: 'week', every: '1', notes: '', on: '', ...rest });

beforeEach(async () => {
  date = addDays(today(), 3);
  c = await makeWedding(date);
});

describe('the switch is designated: offered after the wedding day, two keys, logged, a date of fact', () => {
  it('is not offered before the wedding day is over', async () => {
    await refused(proposeMode(c.slug, { to: 'life' }), /opens the day after the wedding/);
    goToDay(date);
    await as(c.a);
    await refused(proposeMode(c.slug, { to: 'life' }), /opens the day after the wedding/);
    expect(text(await show('page.tsx'))).not.toContain('Switch to life-admin mode');
    await afterTheWedding();
    expect(text(await show('page.tsx'))).toContain('Switch to life-admin mode');
  });

  it('one partner proposes, the other approves; the mode, its request and when it happened are written by the executor alone', async () => {
    await afterTheWedding();
    await ok(proposeMode(c.slug, { to: 'life' }));
    expect(await wedding()).toMatchObject({ mode: 'planning', modeChangedAt: null });
    await refused(proposeMode(c.slug, { to: 'life' }), /already waiting for your partner/);
    await refused(approveRequest(c.slug, { id: (await pending()).id, fingerprint: '' }), /You proposed this/);
    expect(text(await show('page.tsx'))).toContain('A switch is waiting for approval.');
    const r = await pending();
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id, fingerprint: '' }));
    const w = await wedding();
    expect(w).toMatchObject({ mode: 'life', modeRequestId: r.id });
    expect(w.modeChangedAt).not.toBeNull();
    const entry = (await log(c.orgId)).filter((e) => e.action === 'knotwork.wedding.updated').at(-1)!;
    expect(entry.data).toMatchObject({ label: 'Workspace mode', before: { mode: 'planning' }, after: { mode: 'life' }, twoKey: true });
    await refused(proposeMode(c.slug, { to: 'life' }), /already in life-admin mode/);
    // And back, the same way.
    await as(c.b);
    await ok(proposeMode(c.slug, { to: 'planning' }));
    await as(c.a);
    await ok(approveRequest(c.slug, { id: (await pending()).id, fingerprint: '' }));
    expect(await wedding()).toMatchObject({ mode: 'planning' });
    await ok(addTask(c.slug, { title: 'Frame the vows', leadDays: '1', bufferDays: '0', assigneeId: '', dependsOn: [] })); // the plan can be changed again
  });

  it('a declined switch changes nothing', async () => {
    await afterTheWedding();
    await ok(proposeMode(c.slug, { to: 'life' }));
    await as(c.b);
    await ok(declineRequest(c.slug, { id: (await pending()).id, reason: 'Not yet' }));
    expect(await wedding()).toMatchObject({ mode: 'planning', modeChangedAt: null, modeRequestId: null });
  });

  it('in solo mode (D-33) the only partner\'s switch happens at once, marked solo', async () => {
    await resetAuthTables();
    const org = await makeOrg('solo-life');
    const a = (await addMember(org.id, 'owner', 'juniper@example.test')).id;
    await as(a);
    await ok(createWedding(org.slug, { title: 'Juniper', date, timeZone: 'America/Chicago' }));
    goToDay(addDays(date, 1));
    await as(a);
    expect(await ok(proposeMode(org.slug, { to: 'life' }))).toBe(`/o/${org.slug}`);
    expect(await db.wedding.findUniqueOrThrow({ where: { orgId: org.id } })).toMatchObject({ mode: 'life' });
    expect(await db.consentRequest.findFirstOrThrow({ where: { orgId: org.id, kind: 'set_mode' } })).toMatchObject({ status: 'approved', solo: true, deciderId: null });
    const entry = (await log(org.id)).filter((e) => e.action === 'knotwork.wedding.updated').at(-1)!;
    expect(entry.data).toMatchObject({ after: { mode: 'life' }, solo: true });
  });

  it('the database refuses the mode without its own approved request for that mode, and a wedding born in life mode', async () => {
    await afterTheWedding();
    const w = await wedding();
    await expect(db.wedding.update({ where: { id: w.id }, data: { mode: 'life', modeChangedAt: new Date() } })).rejects.toThrow(/needs its own approved set_mode request/);
    // A request of another kind, or an approved one for the other mode, does not do.
    await ok(proposeSettings(c.slug, { spendThreshold: '600', consentExpiryDays: '7', chaseBufferDays: '14' }));
    await as(c.b);
    const settings = await pending('change_settings');
    await ok(approveRequest(c.slug, { id: settings.id, fingerprint: '' }));
    await expect(db.wedding.update({ where: { id: w.id }, data: { mode: 'life', modeRequestId: settings.id, modeChangedAt: new Date() } })).rejects.toThrow(/needs an approved set_mode request/);
    await switchTo('life');
    const back = await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'set_mode', status: 'approved' } });
    await expect(db.wedding.update({ where: { id: w.id }, data: { modeChangedAt: new Date() } })).rejects.toThrow(/change only with the mode/);
    expect(back.payload).toEqual({ to: 'life' });
    await expect(db.$executeRawUnsafe(`UPDATE "Wedding" SET "mode" = 'planning', "modeRequestId" = '${back.id}', "modeChangedAt" = now() WHERE "id" = '${w.id}'`)).rejects.toThrow(/request was for the other mode|its own approved/);
    const other = await makeOrg('born-life');
    await expect(db.wedding.create({ data: { orgId: other.id, title: 'x', date: new Date('2027-01-01T00:00:00Z'), mode: 'life', modeChangedAt: new Date() } })).rejects.toThrow(/starts in planning mode/);
  });
});

describe('the archive: the plan is read-only in life-admin mode, and what carries on still works', () => {
  it('every write to the plan is refused with one clear sentence; pages say they are the archive', async () => {
    await ok(addVendor(c.slug, { name: 'Cedar Hollow Barn', category: 'venue', contactName: '', email: '', phone: '' }));
    await ok(addVendor(c.slug, { name: 'Tin Roof Strings', category: 'dj', contactName: '', email: '', phone: '' }));
    await ok(addTask(c.slug, { title: 'Return the arch', leadDays: '1', bufferDays: '0', assigneeId: c.a, dependsOn: [] }));
    const barn = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Cedar Hollow Barn' } });
    const band = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Tin Roof Strings' } });
    const own = await db.task.findFirstOrThrow({ where: { orgId: c.orgId, title: 'Return the arch' } });
    await ok(addCategory(c.slug, { name: 'Venue', estimate: '9,000' })); // D-153: so the budget refusal below always runs
    const category = await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Venue' } });
    await afterTheWedding();
    await ok(proposeBooking(c.slug, { id: barn.id })); // asked before the switch, approved after: refused then
    const booking = await pending('book_vendor');
    await ok(proposeMode(c.slug, { to: 'life' }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await pending()).id, fingerprint: '' }));
    await refused(approveRequest(c.slug, { id: booking.id, fingerprint: '' }), MODE);
    expect(await db.consentRequest.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({ status: 'pending' }); // rolled back with it
    await as(c.a);
    await refused(addTask(c.slug, { title: 'x', leadDays: '1', bufferDays: '0', assigneeId: '', dependsOn: [] }), MODE);
    await refused(updateTask(c.slug, { id: own.id, title: 'x', leadDays: 1, bufferDays: 1, assigneeId: '', dependsOn: [] }), MODE);
    await refused(setTaskStatus(c.slug, { id: own.id, status: 'done' }), MODE); // even one's own task
    await refused(addVendor(c.slug, { name: 'x', category: 'dj', contactName: '', email: '', phone: '' }), MODE);
    await refused(addExpense(c.slug, { categoryId: category.id, vendorId: '', description: 'x', amount: '1', paidOn: '' }), MODE);
    await refused(saveGuestPlan(c.slug, { cap: '8', venueMin: '', venueMax: '', perHead: '0', kidsMeal: '0', vendorMeal: '0', lockoutDays: '42', minBatchSeats: '1', mealOptions: '' }), MODE);
    await refused(createContingencyPlan(c.slug, { title: 'Rain', starter: 'rain', tree: '' }), MODE);
    await refused(proposeBooking(c.slug, { id: band.id }), MODE); // a designated change to the plan cannot even be asked for
    // The vendor's documents: the upload route answers with the sentence and never reads the file.
    const sent = await attachRoute(multipart(`http://${HOST}/o/${c.slug}/wedding/vendors/${barn.id}/attachments`, 'file', fixture('big.jpg'), {}, { origin: `http://${HOST}`, host: HOST }), { params: Promise.resolve({ org: c.slug, id: barn.id }) });
    expect([sent.status, sent.headers.get('location')]).toEqual([303, `/o/${c.slug}/wedding/vendors/${barn.id}?e=archived#attachments`]);
    expect(await db.vendorAttachment.count({ where: { orgId: c.orgId } })).toBe(0);
    // A helper with every grant is refused the same way; the planning pages are still there, read-only.
    for (const scope of ['schedule_edit', 'vendors_edit', 'guests_edit'] as const) await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope } });
    await as(c.helper);
    await refused(addTask(c.slug, { title: 'x', leadDays: '1', bufferDays: '0', assigneeId: '', dependsOn: [] }), MODE);
    await as(c.a);
    const schedule = text(await show('wedding/schedule/page.tsx'));
    expect(schedule).toContain('From the Archive : the wedding plan is read-only in life-admin mode.');
    expect(schedule).toContain('Return the arch');
    expect(text(await show('wedding/vendors/[id]/page.tsx', { id: barn.id }))).not.toContain('Attach'); // the forms that need an edit grant are gone
    const archive = text(await show('wedding/archive/page.tsx'));
    expect(archive).toContain('read-only');
    expect(archive).toContain('Switch back to planning mode');
  });

  it('what carries on into life-admin mode still works: gifts and thank-yous, the name change, photos, the approval rules', async () => {
    await afterTheWedding();
    await switchTo('life');
    await ok(logReceivedGift(c.slug, { householdId: '', giverName: 'Aunt Hazel', what: 'a quilt', receivedOn: '' }));
    await ok(startNameChange(c.slug, { jurisdiction: 'generic' }));
    await ok(createPhotoEvent(c.slug, { name: 'Reception', mode: 'post', uploadDays: '7', retentionDays: '365' }));
    await ok(proposeSettings(c.slug, { spendThreshold: '600', consentExpiryDays: '7', chaseBufferDays: '14' }));
    const home = text(await show('page.tsx'));
    expect(home).toContain('1st anniversary');
    expect(home).toContain('Thank-yous still owed : 1');
    expect(home).toContain('Aunt Hazel (a quilt)');
    expect(home).toMatch(/Yours: 0 of \d+ steps done\./);
    expect(home).toContain('Reception : 0 photos');
    expect(home).not.toContain('open tasks'); // the planning overview is gone from the home page
  });
});

describe('household tasks: a rule and a done-on log; the due day is computed on every read', () => {
  it('begin in life-admin mode; add, mark done, take a day off, change, remove; each logged', async () => {
    await refused(task('add', { title: 'Change the furnace filter', unit: 'month', every: '3' }), /begin in life-admin mode/);
    await afterTheWedding(10);
    await switchTo('life');
    const t0 = today();
    await ok(task('add', { title: 'Change the furnace filter', unit: 'month', every: '3' }));
    await ok(task('add', { title: 'Anniversary dinner', unit: 'anniversary', every: '7' })); // once a year whatever was typed
    await refused(task('add', { title: 'Too often', unit: 'week', every: '53' }), /every 1 to 365 days, 1 to 52 weeks, 1 to 24 months/);
    await refused(task('add', { title: '', unit: 'day', every: '1' }), /Give the task a title/);
    const filter = await db.recurringTask.findFirstOrThrow({ where: { orgId: c.orgId, title: 'Change the furnace filter' } });
    expect(await db.recurringTask.findFirstOrThrow({ where: { orgId: c.orgId, title: 'Anniversary dinner' } })).toMatchObject({ unit: 'anniversary', every: 1 });
    await refused(task('add', { id: filter.id, title: 'x', unit: 'day' }), /no id yet/);
    await refused(task('done'), /Pick a task/);
    let page = text(await show('wedding/life/page.tsx'));
    expect(page).toContain('Change the furnace filter : due today (never done)');
    expect(page).toContain(`Anniversary dinner : coming up (never done)`);
    // Done today: next due in three months (the month end clamps; computed, not stored).
    await ok(task('done', { id: filter.id }));
    await refused(task('done', { id: filter.id }), /already marked done/);
    await refused(task('done', { id: filter.id, on: addDays(t0, 1) }), /has not come yet/);
    await refused(task('done', { id: filter.id, on: addDays(date, -1) }), /start from the wedding day/);
    await refused(task('done', { id: filter.id, on: '2027-02-30' }), /real date/);
    page = text(await show('wedding/life/page.tsx'));
    expect(page).toContain('Change the furnace filter : coming up');
    expect(await db.recurringDone.count({ where: { taskId: filter.id } })).toBe(1);
    await ok(task('undo', { id: filter.id, on: t0 }));
    await refused(task('undo', { id: filter.id, on: t0 }), /not marked done/);
    await ok(task('done', { id: filter.id, on: addDays(t0, -2) }));
    await ok(task('edit', { id: filter.id, title: 'Change the filter', unit: 'week', every: '1', notes: 'The 16x25 one' }));
    page = text(await show('wedding/life/page.tsx'));
    expect(page).toContain('Change the filter : due soon');
    expect(page).toContain('every week; last done');
    await ok(task('remove', { id: filter.id }));
    expect(await db.recurringDone.count({ where: { taskId: filter.id } })).toBe(0);
    const verbs = (await log(c.orgId)).filter((e) => e.action.startsWith('knotwork.recurring.')).map((e) => e.action.replace('knotwork.recurring.', ''));
    expect(verbs).toEqual(['created', 'created', 'done', 'undone', 'done', 'updated', 'deleted']);
    // No column holds a due day: the rows are the rule and the days of fact.
    const row = await db.recurringTask.findFirstOrThrow({ where: { orgId: c.orgId } });
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'createdById', 'every', 'id', 'notes', 'orgId', 'title', 'unit']);
  });

  it('another workspace\'s task is not found, like a missing one', async () => {
    await afterTheWedding();
    await switchTo('life');
    const other = await makeOrg('sage-wren');
    const theirs = await db.recurringTask.create({ data: { orgId: other.id, title: 'Theirs', unit: 'day', every: 2 } });
    for (const id of [theirs.id, '00000000-0000-4000-8000-000000000000']) {
      for (const op of ['done', 'remove', 'edit']) expect(await outcome(task(op, { id, title: 'Mine now', unit: 'day', every: '1' })), op).toMatchObject({ nav: 'notFound' });
    }
    expect(await db.recurringTask.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ title: 'Theirs' });
    expect(await db.recurringDone.count()).toBe(0);
  });
});

describe('helpers in life-admin mode (D-147): the album if they moderate it, the archive read-only, nothing else', () => {
  it('a helper sees no household tasks, thank-yous, name change or documents they have no grant for', async () => {
    await ok(createPhotoEvent(c.slug, { name: 'Reception', mode: 'post', uploadDays: '7', retentionDays: '365' }));
    await afterTheWedding();
    await switchTo('life');
    await ok(task('add', { title: 'Water the fig', unit: 'day', every: '3' }));
    await ok(logReceivedGift(c.slug, { householdId: '', giverName: 'Aunt Hazel', what: 'a quilt', receivedOn: '' }));
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'photos_moderate' } });
    await as(c.helper);
    const html = await show('page.tsx');
    const home = text(html);
    expect(home).toContain('1st anniversary');
    expect(html).toContain('aria-label="Photo albums"');
    expect(home).toContain('Reception');
    for (const section of ['Household tasks', 'Thank-yous still owed', 'Name change', 'Documents']) expect(html, section).not.toContain(`aria-label="${section}"`);
    for (const s of ['Water the fig', 'Aunt Hazel', 'a quilt']) expect(home, s).not.toContain(s);
    expect(await show('wedding/life/page.tsx')).toBe(NOT_FOUND);
    await refused(task('add', { title: 'Mine', unit: 'day', every: '1' }), /do not have access/);
    expect(await show('wedding/schedule/page.tsx')).not.toBe(NOT_FOUND); // every helper reads the schedule, now the archive
    expect(await show('wedding/budget/page.tsx')).toBe(NOT_FOUND); // no grant, no page, as before
  });
});

describe('secrecy holds in life-admin mode: every page, by glob', () => {
  it('a vendor private to Juniper "never" shows no name, document or task to Rowan or a helper with every grant', async () => {
    await ok(addVendor(c.slug, { name: `${SECRET} Glasswing Engravers`, category: 'other', contactName: '', email: '', phone: '', privacy: 'never' }));
    await ok(addVendor(c.slug, { name: 'Fennel & Fig Catering', category: 'caterer', contactName: '', email: '', phone: '' }));
    const [secret, shared] = [await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: { startsWith: SECRET } } }), await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Fennel & Fig Catering' } })];
    await ok(addTask(c.slug, { title: `${SECRET} Engrave the watch`, leadDays: '1', bufferDays: '0', assigneeId: '', dependsOn: [], privacy: 'never' }));
    for (const [v, label] of [[secret, `${SECRET} contract page`], [shared, 'Catering contract']] as const) {
      const sent = await attachRoute(multipart(`http://${HOST}/o/${c.slug}/wedding/vendors/${v.id}/attachments`, 'file', fixture('big.jpg'), { label }, { origin: `http://${HOST}`, host: HOST }), { params: Promise.resolve({ org: c.slug, id: v.id }) });
      expect(sent.status).toBe(303);
    }
    for (const scope of ['schedule_edit', 'budget_edit', 'vendors_edit', 'guests_edit', 'photos_moderate'] as const) await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope } });
    await afterTheWedding();
    await switchTo('life');
    const zero = '00000000-0000-4000-8000-000000000000';
    const sweep = async () => {
      const out: Record<string, string> = {};
      for (const [file, load] of Object.entries(PAGES)) out[file] = await render(await load(), { org: c.slug, id: file.includes('/vendors/') ? shared.id : zero, event: zero, photo: zero, kind: 'thumb' });
      return out;
    };
    expect(Object.keys(PAGES)).toEqual(expect.arrayContaining([page('wedding/life/page.tsx'), page('wedding/archive/page.tsx'), page('page.tsx')]));
    const mine = await sweep();
    expect(mine[page('page.tsx')]).toContain(`${SECRET} contract page`); // not blind: Juniper sees her own
    expect(mine[page('wedding/schedule/page.tsx')]).toContain(`${SECRET} Engrave the watch`);
    for (const who of [c.b, c.helper]) {
      await as(who);
      const pages = await sweep();
      for (const [file, html] of Object.entries(pages)) expect(html, `${who}: ${file}`).not.toContain(SECRET);
      expect(text(pages[page('page.tsx')]!)).toContain('1 more document belongs to a private vendor.');
      expect(text(pages[page('page.tsx')]!)).toContain('Catering contract');
    }
  });
});

describe('guest-facing surfaces in life-admin mode (D-148)', () => {
  it('the RSVP link still shows the invitation and takes no reply; no reminder is sent; the same sentence for every household', async () => {
    date = addDays(today(), 100); // far enough out to release both lists
    c = await makeWedding(date);
    await ok(saveGuestPlan(c.slug, { cap: '8', venueMin: '', venueMax: '', perHead: '0', kidsMeal: '0', vendorMeal: '0', lockoutDays: '42', minBatchSeats: '1', mealOptions: '' }));
    await ok(importGuests(c.slug, { csv: 'household,name,email,list,priority,age_group,partner_status\nThe Sterns,Ruth Stern,ruth@stern.example,A,1,adult,none\nSam Webb,Sam Webb,sam@webb.example,B,10,adult,none\n', confirm: 'on' }));
    await ok(releaseWave(c.slug, { list: 'A' }));
    await ok(releaseWave(c.slug, { list: 'B' }));
    const tokenOf = async (name: string) => String(((await outcome(showRsvpLink(c.slug, { id: (await db.household.findFirstOrThrow({ where: { orgId: c.orgId, name } })).id }))).result as { notice: string }).notice).split('/r/')[1]!;
    const [a, b] = [await tokenOf('The Sterns'), await tokenOf('Sam Webb')];
    await afterTheWedding();
    await switchTo('life');
    for (const token of [a, b]) {
      const view = await readRsvp(token, IP);
      expect(view).not.toBeNull();
      const guest = (view as { guests: { id: string }[] }).guests[0]!;
      expect(await submitRsvp(token, IP, { responses: [{ guestId: guest.id, attending: true, meal: '', dietary: [], accessibility: [], songRequest: '' }], plusOneName: '' })).toEqual({ ok: false, message: 'Replies are closed now. Please get in touch with the couple.' });
    }
    expect(await db.guest.count({ where: { orgId: c.orgId, rsvp: { not: 'pending' } } })).toBe(0);
    expect(await withOrg({ orgId: c.orgId }, (tx) => sendDueReminders(tx, { orgId: c.orgId, userId: null }))).toBe(0);
    await refused(sendReminders(c.slug, {}), MODE);
    expect(ARCHIVE_REFUSAL).toMatch(MODE);
  });
});
