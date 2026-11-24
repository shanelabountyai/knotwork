import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from '@/app/o/[org]/wedding/actions';
import * as plans from '@/app/o/[org]/wedding/contingency/actions';
import * as gifts from '@/app/o/[org]/wedding/gifts/actions';
import * as guestActions from '@/app/o/[org]/wedding/guests/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { taskFigures } from '@/lib/knotwork/dashboard/figures';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { loadSchedule } from '@/lib/knotwork/schedule/store';
import { as, db, makeWedding, ok, snapshot, type Couple } from './db';
import { PAGES, render } from './render';

// P1-7, the progress dashboard, rendered as each person would get it: every figure read from the engine that owns it
// (nothing stored, nothing written by looking), a private item counted in the figures but never named, and a helper
// shown only the sections their grants reach.
const today = () => todayIn('America/Chicago', now());
const SECRET = 'ZEPHYR-7';
let c: Couple;
const HOME = 'src/app/o/[org]/page.tsx';
const dashboard = async () => render(await PAGES['src/app/o/[org]/wedding/dashboard/page.tsx']!(), { org: c.slug });
const SECTIONS = ['Tasks', 'Vendor flags', 'Headcount', 'Approvals', 'Budget', 'Thank-you notes', 'Contingency plans'];
const sections = (html: string) => SECTIONS.filter((s) => html.includes(`<section aria-label="${s}">`));

beforeEach(async () => {
  c = await makeWedding(addDays(today(), 330));
  // Two overdue tasks (due 400 days before a wedding 330 days away): one shared, one private to Juniper.
  await ok(actions.addTask(c.slug, { title: 'Book the brass band', leadDays: '5', bufferDays: '400', assigneeId: '', dependsOn: [] }));
  await ok(actions.addTask(c.slug, { title: `${SECRET} Engrave the watch`, leadDays: '5', bufferDays: '401', assigneeId: '', dependsOn: [], privacy: '0' }));
  await ok(actions.addCategory(c.slug, { name: 'Catering', estimate: '10,000' }));
  await ok(actions.addCategory(c.slug, { name: `${SECRET} Watch`, estimate: '900', privacy: '0' }));
  const catering = await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Catering' } });
  const watch = await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: `${SECRET} Watch` } });
  await ok(actions.addExpense(c.slug, { categoryId: catering.id, vendorId: '', description: 'Tasting', amount: '150', paidOn: '' }));
  await ok(actions.addExpense(c.slug, { categoryId: watch.id, vendorId: '', description: `${SECRET} strap`, amount: '80', paidOn: '' }));
  await ok(actions.addVendor(c.slug, { name: 'Fennel & Fig', category: 'caterer', contactName: '', email: '', phone: '' }));
  const vendor = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Fennel & Fig' } });
  await ok(actions.proposeBooking(c.slug, { id: vendor.id }));
  await ok(gifts.logReceivedGift(c.slug, { householdId: '', giverName: 'Great-aunt Odile', what: 'a quilt', receivedOn: addDays(today(), -30) }));
  await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
  await ok(guestActions.saveGuestPlan(c.slug, { cap: '40', venueMin: '', venueMax: '60', perHead: '0', kidsMeal: '0', vendorMeal: '0', lockoutDays: '42', minBatchSeats: '1', mealOptions: 'Chicken' }));
});

describe('the figures', () => {
  it('every figure is the engines\' own, worked out on the request; looking writes nothing', async () => {
    const { schedule } = await withOrg({ orgId: c.orgId }, async (tx) => loadSchedule(tx, { orgId: c.orgId }, await tx.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } })));
    const f = taskFigures(Object.values(schedule.tasks).map((t) => t.state));
    expect(f.late).toBe(2);
    const before = await snapshot();
    const html = await dashboard();
    expect(await snapshot()).toBe(before);
    expect(html).toContain(`Tasks</a>: ${f.onTrackPct}% on track`);
    expect(html).toContain(`${f.total} tasks: ${f.done} done, ${f.onTrack} open and on track, 2 overdue,`);
    expect(html).toContain('<li>Book the brass band: due '); // the shared overdue task by name
    expect(html).toContain('$230.00 spent of $10,900.00 (2%)'); // the private line is in both totals
    expect(html).not.toContain('The totals include'); // nothing is hidden from Juniper: both private lines are hers
    expect(html).toContain('Approvals</a>: 0 waiting for you'); // Juniper proposed; it waits for Rowan
    expect(html).toContain('1 request of yours waits for your partner.');
    expect(html).toContain('1 unthanked &gt; 3 weeks');
    expect(html).toContain('Oldest: Great-aunt Odile, 30 days');
    expect(html).toContain('Contingency plans</a>: 1 ready, 0 put into action');
    expect(html).toContain('Headcount</a>: 0 of 40 seats held (0%)');
    expect(html).toContain('The venue takes any number to 60');
    expect(html).toContain('0 of 0 seated at 0 tables');
    // Juniper sees her own secret by name; it is hers.
    expect(html).toContain(`${SECRET} Engrave the watch`);
  });

  it('the home page links to it prominently', async () => {
    expect(await render(await PAGES[HOME]!(), { org: c.slug })).toContain(`<a href="/o/${c.slug}/wedding/dashboard"><strong>Progress dashboard</strong></a>`);
  });
});

describe('secrecy and grants', () => {
  it('the other partner gets the same figures, the private task as a masked line, and no private label anywhere', async () => {
    const mine = await dashboard();
    await as(c.b);
    const html = await dashboard();
    expect(html).not.toContain(SECRET);
    expect(html).toContain('Private task');
    expect(html).toContain('2 overdue');
    expect(html).toContain('$230.00 spent of $10,900.00');
    expect(html).toContain('The totals include 2 private lines.'); // Juniper's category and its spend
    expect(html).toContain('Approvals</a>: 1 waiting for you');
    // The task figures are identical for both partners: masking changes labels, never counts.
    const pct = (h: string) => /(\d+)% on track/.exec(h)![1];
    expect(pct(html)).toBe(pct(mine));
  });

  it('a helper sees only what their grants reach, and nothing private', async () => {
    await as(c.helper);
    let html = await dashboard();
    expect(sections(html)).toEqual(['Tasks']);
    expect(html).not.toContain(SECRET);
    expect(html).toContain('Private task');
    await as(c.a);
    await ok(actions.grantHelper(c.slug, { userId: c.helper, scope: 'budget_view' }));
    await as(c.helper);
    html = await dashboard();
    expect(sections(html)).toEqual(['Tasks', 'Budget']);
    expect(html).toContain('$230.00 spent of $10,900.00');
    expect(html).not.toContain(SECRET);
    await as(c.a);
    await ok(actions.grantHelper(c.slug, { userId: c.helper, scope: 'guests_edit' }));
    await ok(actions.grantHelper(c.slug, { userId: c.helper, scope: 'vendors_view' }));
    await as(c.helper);
    html = await dashboard();
    // Approvals, thank-yous and contingency plans are the partners' alone: no grant reaches them.
    expect(sections(html)).toEqual(['Tasks', 'Vendor flags', 'Headcount', 'Budget']);
    for (const s of ['Great-aunt Odile', 'unthanked', 'Rain plan', 'waiting for you']) expect(html).not.toContain(s);
  });
});
