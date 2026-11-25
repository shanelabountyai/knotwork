import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from '@/app/o/[org]/wedding/actions';
import * as plans from '@/app/o/[org]/wedding/contingency/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { STARTERS } from '@/lib/knotwork/contingency/schema';
import { previewBranch } from '@/lib/knotwork/contingency/preview';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { loadSchedule } from '@/lib/knotwork/schedule/store';
import { seenOf } from '@/lib/knotwork/secrecy/seal';
import { contingencyWorld } from '@/lib/knotwork/secrecy/views';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';
import { NOT_FOUND, PAGES, render } from './render';

// P1-6, contingency decision trees, through the real actions and pages: create a plan, preview a branch (exactly what
// would change), execute it (one transaction under the wedding lock, logged; tasks through the scheduler so their dates
// derive from the wedding date; a spend over the threshold only PROPOSED through consent, rule 2), and a plan runs once.
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let wedding: string;
const DETAIL = 'src/app/o/[org]/wedding/contingency/[id]/page.tsx';
const plan = (title = 'Rain plan') => db.contingencyPlan.findFirstOrThrow({ where: { orgId: c.orgId, title } });
const detail = async (id: string, path = '') => render(await PAGES[DETAIL]!(), { org: c.slug, id }, path ? { path } : {});
/** The fingerprint the page would show this person for this branch, as the page computes it. */
async function fp(userId: string, id: string, path: number[]) {
  return withOrg({ orgId: c.orgId }, async (tx) => {
    const w = await tx.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } });
    const p = await tx.contingencyPlan.findUniqueOrThrow({ where: { id } });
    return previewBranch(p.tree as never, path, await contingencyWorld(tx, { orgId: c.orgId }, w, (await seenOf(tx, c.orgId, userId))!))!.fingerprint;
  });
}
const execute = async (userId: string, id: string, path: number[]) => plans.executeContingencyBranch(c.slug, { id, path: path.join('.'), fingerprint: await fp(userId, id, path) });

beforeEach(async () => {
  wedding = addDays(today(), 330);
  c = await makeWedding(wedding);
  await as(c.a);
  await ok(actions.addCategory(c.slug, { name: 'Venue', estimate: '9,500' }));
  await ok(actions.addVendor(c.slug, { name: 'Cedar Hollow Barn', category: 'venue', contactName: '', email: 'events@cedarhollow.example', phone: '918-555-0111' }));
  await ok(actions.addVendor(c.slug, { name: 'Wild Rye Flowers', category: 'florist', contactName: '', email: '', phone: '' })); // considered, not booked
  const barn = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Cedar Hollow Barn' } });
  await ok(actions.proposeBooking(c.slug, { id: barn.id }));
  await as(c.b);
  await ok(actions.approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'book_vendor' } })).id }));
  await as(c.a);
});

describe('create and preview', () => {
  it('a plan from a starter; the page walks the questions and previews exactly what one outcome would do; nothing is written', async () => {
    await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    const p = await plan();
    expect(p.tree).toEqual(STARTERS.rain.tree);
    const list = await render(await PAGES['src/app/o/[org]/wedding/contingency/page.tsx']!(), { org: c.slug });
    expect(list).toContain('Rain plan</a>: 4 outcomes. Not put into action.');
    const before = await snapshot();
    expect(await detail(p.id)).toContain('Two days out, what does the forecast say for the ceremony?');
    expect(await detail(p.id, '0')).toContain('Can the ceremony move into the barn?');
    const tent = await detail(p.id, '0.1');
    expect(tent).toContain('Rent a tent for the lawn');
    expect(tent).toContain('<strong>Cedar Hollow Barn</strong> (918-555-0111): A tent rental company will set up on the lawn the day before.');
    expect(tent).toContain('Book a tent for the lawn');
    expect(tent).toContain('Tent rental for the lawn (Venue), $1,800.00: over $500.00, so it is proposed for your partner to approve');
    expect(tent).toContain(`name="fingerprint" value="${await fp(c.a, p.id, [0, 1])}"`);
    const inside = await detail(p.id, '0.0');
    expect(inside).toContain('No florist is booked yet.'); // Wild Rye is only being considered
    expect(await detail(p.id, '9.9')).toContain('Two days out'); // a path that does not exist starts again at the top
    expect(await snapshot()).toBe(before); // previewing writes nothing
  });

  it('a pasted tree is validated before anything is stored: a cycle, a branch to nowhere and bad JSON are refused', async () => {
    const before = await snapshot();
    const leaf = { type: 'leaf', title: 'Done', checklist: [], notify: [], tasks: [], spends: [] };
    await refused(plans.createContingencyPlan(c.slug, { title: 'Loop', starter: '', tree: JSON.stringify({ root: 'a', nodes: { a: { type: 'question', text: '?', branches: [{ label: 'again', next: 'a' }, { label: 'stop', next: 'b' }] }, b: leaf } }) }), /leads back to itself/);
    await refused(plans.createContingencyPlan(c.slug, { title: 'Lost', starter: '', tree: JSON.stringify({ root: 'a', nodes: { a: { type: 'question', text: '?', branches: [{ label: 'x', next: 'b' }, { label: 'y', next: 'gone' }] }, b: leaf } }) }), /leads to "gone", which is not in the plan/);
    await refused(plans.createContingencyPlan(c.slug, { title: 'Bad', starter: '', tree: '{nope' }), /not valid JSON/);
    await refused(plans.createContingencyPlan(c.slug, { title: 'None', starter: 'nope', tree: '' }), /Pick a starter/);
    expect(await snapshot()).toBe(before);
    await ok(plans.createContingencyPlan(c.slug, { title: 'Tiny', starter: '', tree: JSON.stringify({ root: 'a', nodes: { a: { type: 'question', text: 'Late?', branches: [{ label: 'yes', next: 'b' }, { label: 'no', next: 'c' }] }, b: { ...leaf, checklist: ['Call'] }, c: leaf } }) }));
    await refused(plans.createContingencyPlan(c.slug, { title: 'Tiny', starter: 'rain', tree: '' }), /already a plan with that name/);
  });
});

describe('execute a branch', () => {
  it('the tent: tasks through the scheduler (dates from the wedding), the vendor to tell, the spend PROPOSED, never spent; one run, logged', async () => {
    await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    const p = await plan();
    const tasksBefore = await db.task.count({ where: { orgId: c.orgId } });
    await ok(execute(c.a, p.id, [0, 1]));

    const added = await db.task.findMany({ where: { orgId: c.orgId, title: { in: ['Book a tent for the lawn', 'Check the tent is up, lit and dry'] } }, include: { dependsOn: true }, orderBy: { title: 'asc' } });
    expect(await db.task.count({ where: { orgId: c.orgId } })).toBe(tasksBefore + 2);
    expect(added.map((t) => [t.title, t.kind, t.leadDays, t.bufferDays, t.dependsOn.length])).toEqual([['Book a tent for the lawn', 'manual', 2, 1, 0], ['Check the tent is up, lit and dry', 'manual', 0, 0, 1]]);
    // Their dates are derived, like every task's (rule 1): the tent is due the day before the wedding, its check on the day.
    const { schedule } = await withOrg({ orgId: c.orgId }, async (tx) => loadSchedule(tx, { orgId: c.orgId }, await tx.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } })));
    expect(added.map((t) => schedule.tasks[t.id]!.due)).toEqual([addDays(wedding, -1), wedding]);

    // Rule 2: the $1,800 tent is a pending spend request, not an expense.
    const requests = await db.consentRequest.findMany({ where: { orgId: c.orgId, kind: 'spend' } });
    expect(requests.map((r) => [r.status, r.proposerId, r.summary])).toEqual([['pending', c.a, 'Spend $1,800.00: Tent rental for the lawn (Venue), from the plan "Rain plan"']]);
    expect(await db.expense.count({ where: { orgId: c.orgId } })).toBe(0);

    const run = await db.contingencyRun.findUniqueOrThrow({ where: { planId: p.id }, include: { items: { orderBy: { position: 'asc' } } } });
    expect(run).toMatchObject({ leaf: 'tent', path: [0, 1], executedById: c.a, result: { tasks: expect.arrayContaining(added.map((t) => t.id)), expenses: [], requests: [requests[0]!.id] } });
    expect(run.items.map((i) => [i.kind, i.text, !!i.vendorId])).toEqual([
      ['check', 'Confirm where the tent can be staked with the venue', false],
      ['check', 'Tell the wedding party to expect the tent', false],
      ['notify', 'Tell Cedar Hollow Barn: A tent rental company will set up on the lawn the day before.', true],
    ]);
    const entries = (await log(c.orgId)).map((e) => [e.action, (e.data as { label: string }).label]);
    expect(entries.slice(-4)).toEqual([
      ['knotwork.task.created', 'Book a tent for the lawn'], ['knotwork.task.created', 'Check the tent is up, lit and dry'],
      ['knotwork.request.proposed', 'Spend $1,800.00: Tent rental for the lawn (Venue), from the plan "Rain plan"'],
      ['knotwork.contingency.executed', 'Rain plan'],
    ]);

    // The other partner approves the spend on the approvals page: the consent module records it, with both keys.
    await as(c.b);
    await ok(actions.approveRequest(c.slug, { id: requests[0]!.id }));
    expect(await db.expense.findMany({ where: { orgId: c.orgId }, select: { description: true, amountCents: true, requestId: true } })).toEqual([{ description: 'Tent rental for the lawn', amountCents: 180_000, requestId: requests[0]!.id }]);

    // The page now shows what was done and the checklist, ticked off one by one (a day of fact).
    await as(c.a);
    const html = await detail(p.id);
    expect(html).toContain('2 tasks added to the');
    expect(html).toContain('1 spends waiting on the');
    await ok(plans.tickContingencyItem(c.slug, { id: run.items[2]!.id, done: 'on' }));
    expect(await db.contingencyItem.findUniqueOrThrow({ where: { id: run.items[2]!.id } })).toMatchObject({ doneOn: new Date(`${today()}T00:00:00Z`), doneById: c.a });
    await ok(plans.tickContingencyItem(c.slug, { id: run.items[2]!.id, done: '' }));
    expect((await db.contingencyItem.findUniqueOrThrow({ where: { id: run.items[2]!.id } })).doneOn).toBeNull();
  });

  it('a plan runs once: a second execute is refused (any branch), and the database refuses a second run and a changed tree', async () => {
    await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    const p = await plan();
    await ok(execute(c.a, p.id, [2]));
    const before = await snapshot();
    await refused(execute(c.a, p.id, [2]), /already put into action/);
    await refused(execute(c.a, p.id, [1]), /already put into action/);
    await refused(plans.updateContingencyPlan(c.slug, { id: p.id, title: 'Rain plan', tree: JSON.stringify(STARTERS['late-arrival'].tree) }), /already put into action/);
    await refused(plans.removeContingencyPlan(c.slug, { id: p.id }), /stays as the record/);
    expect(await snapshot()).toBe(before);
    await expect(db.contingencyRun.create({ data: { orgId: c.orgId, planId: p.id, path: [1], leaf: 'showers', fingerprint: '0123456789abcdef', result: {} } })).rejects.toThrow(/Unique constraint|planId/);
    await expect(db.contingencyPlan.update({ where: { id: p.id }, data: { tree: STARTERS['late-arrival'].tree as never } })).rejects.toThrow(/cannot change/);
  });

  it('executes only what was previewed: a stale fingerprint is refused, and nothing is written', async () => {
    await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    const p = await plan();
    const seen = await fp(c.a, p.id, [1]); // showers: $120 of umbrellas, under the $500 threshold, so it would be recorded
    // Then the rules change, with both keys: now anything over $100 needs both, so the umbrellas would be proposed.
    await ok(actions.proposeSettings(c.slug, { spendThreshold: '100', consentExpiryDays: '7', chaseBufferDays: '14' }));
    await as(c.b);
    await ok(actions.approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'change_settings' } })).id }));
    await as(c.a);
    const before = await snapshot();
    await refused(plans.executeContingencyBranch(c.slug, { id: p.id, path: '1', fingerprint: seen }), /changed since the preview/);
    await refused(plans.executeContingencyBranch(c.slug, { id: p.id, path: '0', fingerprint: seen }), /Answer every question first/);
    await refused(plans.executeContingencyBranch(c.slug, { id: p.id, path: 'x', fingerprint: seen }), /Answer every question first/);
    expect(await snapshot()).toBe(before);
    await ok(execute(c.a, p.id, [1]));
    expect(await db.consentRequest.count({ where: { orgId: c.orgId, kind: 'spend', status: 'pending' } })).toBe(1);
  });

  it('a spend at or under the threshold is recorded at once, with no request', async () => {
    await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    await ok(execute(c.a, (await plan()).id, [1]));
    expect(await db.expense.findMany({ where: { orgId: c.orgId }, select: { description: true, amountCents: true, requestId: true, paidOn: true } })).toEqual([{ description: 'Umbrellas for guests', amountCents: 12_000, requestId: null, paidOn: new Date(`${today()}T00:00:00Z`) }]);
    expect(await db.consentRequest.count({ where: { orgId: c.orgId, kind: 'spend' } })).toBe(0);
  });

  it('a missing category refuses the branch; a designated spend into a category private to the executor is refused, not revealed', async () => {
    await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    const p = await plan();
    await ok(plans.createContingencyPlan(c.slug, { title: 'Party tent', starter: '', tree: JSON.stringify({ root: 'a', nodes: { a: { type: 'leaf', title: 'Tent for the after-party', spends: [{ category: 'Surprise', description: 'Tent', amountCents: 90_000 }] } } }) }));
    const tent = await plan('Party tent');
    await refused(execute(c.a, tent.id, []), /no budget category called "Surprise"/);
    await ok(actions.addCategory(c.slug, { name: 'Surprise', estimate: '1,000', privacy: 'never' }));
    await refused(execute(c.a, tent.id, []), /"Surprise" is private to you, and \$900\.00 needs both of you/);
    // To Rowan the category does not exist at all: the same refusal as a missing one.
    await as(c.b);
    await refused(execute(c.b, tent.id, []), /no budget category called "Surprise"/);
    expect((await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Surprise' } })).privateToId).toBe(c.a); // nothing revealed
    expect(await detail(p.id, '0.1')).not.toContain('Surprise');
  });

  it('in solo mode the proposal executes at once, still inside the consent module, marked solo (D-33)', async () => {
    const org = await makeOrg('solo-plan');
    const solo = (await addMember(org.id, 'owner', 'solo@example.test')).id;
    await as(solo);
    await ok(actions.createWedding(org.slug, { title: 'Solo', date: addDays(today(), 200), timeZone: '' }));
    await ok(actions.addCategory(org.slug, { name: 'Venue', estimate: '5,000' }));
    await ok(plans.createContingencyPlan(org.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    const p = await db.contingencyPlan.findFirstOrThrow({ where: { orgId: org.id } });
    const fingerprint = await withOrg({ orgId: org.id }, async (tx) => previewBranch(p.tree as never, [0, 1], await contingencyWorld(tx, { orgId: org.id }, await tx.wedding.findUniqueOrThrow({ where: { orgId: org.id } }), (await seenOf(tx, org.id, solo))!))!.fingerprint);
    await ok(plans.executeContingencyBranch(org.slug, { id: p.id, path: '0.1', fingerprint }));
    const r = await db.consentRequest.findFirstOrThrow({ where: { orgId: org.id, kind: 'spend' } });
    expect([r.status, r.solo]).toEqual(['approved', true]);
    expect(await db.expense.findFirstOrThrow({ where: { orgId: org.id } })).toMatchObject({ amountCents: 180_000, requestId: r.id });
  });
});

describe('who and where', () => {
  it('helpers see no plan and can do nothing; another workspace\'s plan or item is not found before any rule', async () => {
    await ok(plans.createContingencyPlan(c.slug, { title: 'Rain plan', starter: 'rain', tree: '' }));
    const p = await plan();
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'schedule_edit' } });
    await as(c.helper);
    expect(await render(await PAGES['src/app/o/[org]/wedding/contingency/page.tsx']!(), { org: c.slug })).toBe(NOT_FOUND);
    expect(await detail(p.id)).toBe(NOT_FOUND);
    await refused(execute(c.helper, p.id, [2]), /do not have access/);

    await as(c.a);
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    const theirs = await db.contingencyPlan.create({ data: { orgId: other.id, title: 'Theirs', tree: STARTERS.rain.tree as never } });
    const run = await db.contingencyRun.create({ data: { orgId: other.id, planId: theirs.id, path: [2], leaf: 'dry', fingerprint: '0123456789abcdef', result: {} } });
    const item = await db.contingencyItem.create({ data: { orgId: other.id, runId: run.id, position: 0, kind: 'check', text: 'x' } });
    const before = await snapshot();
    for (const call of [
      () => plans.executeContingencyBranch(c.slug, { id: theirs.id, path: 'not a path', fingerprint: '' }),
      () => plans.updateContingencyPlan(c.slug, { id: theirs.id, title: 'x', tree: '{bad' }),
      () => plans.removeContingencyPlan(c.slug, { id: theirs.id }),
      () => plans.tickContingencyItem(c.slug, { id: item.id, done: 'on' }),
    ]) expect((await outcome(call())).nav).toBe('notFound');
    expect(await detail(theirs.id)).toBe(NOT_FOUND);
    expect(await snapshot()).toBe(before);
    // And the database keeps a run, an item and an item's vendor inside one workspace.
    await expect(db.contingencyRun.create({ data: { orgId: c.orgId, planId: theirs.id, path: [], leaf: 'x', fingerprint: '0123456789abcdef', result: {} } })).rejects.toThrow(/same workspace/);
    const barn = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Cedar Hollow Barn' } });
    await expect(db.contingencyItem.create({ data: { orgId: other.id, runId: run.id, position: 1, kind: 'notify', text: 'x', vendorId: barn.id } })).rejects.toThrow(/same workspace/);
    await expect(db.contingencyItem.create({ data: { orgId: other.id, runId: run.id, position: 2, kind: 'check', text: 'x', vendorId: null, doneOn: new Date() } })).rejects.toThrow(/ContingencyItem_done_check/);
  });
});
