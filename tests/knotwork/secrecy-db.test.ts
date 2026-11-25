import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportTables } from '@/app/export-hooks';
import {
  addCategory, addExpense, addTask, addVendor, addVendorPayment, payVendorPayment, proposeBooking, proposeContract, proposeDateMove, regenerateBrief, removeTask, setTaskStatus, takeBudgetSnapshot, updateTask, updateVendor,
} from '@/app/o/[org]/wedding/actions';
import { addFunder, addPledge, linkFunder, payFromPledge, recordReceipt } from '@/app/o/[org]/wedding/funding/actions';
import { setCategoryPrivacy, setExpensePrivacy, setTaskPrivacy, setVendorPrivacy } from '@/app/o/[org]/wedding/privacy/actions';
import { GET as attachmentRoute } from '@/app/o/[org]/wedding/vendors/[id]/attachments/[attachment]/route';
import { POST as attachRoute } from '@/app/o/[org]/wedding/vendors/[id]/attachments/route';
import { auditCsv, auditFilter } from '@/core/audit';
import { AuthzError, requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { buildExport, requestExport } from '@/core/tenancy/export';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { previewDateMove } from '@/lib/knotwork/schedule/store';
import { NavSignal } from '../helpers/next';
import { addMember, actAs, makeOrg } from '../helpers/org';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, type Couple } from './db';
import { FORBIDDEN, get, NOT_FOUND, PAGES, render } from './render';
import { fixture, multipart } from './uploads';

// P1-1 secrecy compartments (ADR-001). The LEAK SWEEP: Juniper (partner A) keeps a task, a vendor, a budget category and
// spends private, each labelled with the marker ZQX, with everything that hangs off them (a payment and its task, a
// brief, an attachment, a pledge and a payment from it, a snapshot, a dependency, a pending date move). Then every
// signed-in Knotwork page (found by glob), the template's audit log and its CSV, both attachment routes, the change
// log as stored, and the data export are read as Rowan (partner B), as a helper holding every grant, and as a helper
// linked to a funder: the marker never appears. Juniper sees all of it (the sweep is not blind).
const SECRET = 'ZQX';
const HOST = 'localhost:8400';
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let wedding: string;
let ids: { task: string; vendor: string; publicVendor: string; category: string; catering: string; spend: string; strap: string; attachment: string; funderHelper: string };

const find = {
  task: (title: string) => db.task.findFirstOrThrow({ where: { orgId: c.orgId, title } }),
  vendor: (name: string) => db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name } }),
  category: (name: string) => db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId, name } }),
  expense: (description: string) => db.expense.findFirstOrThrow({ where: { orgId: c.orgId, description } }),
};
const fp = async (to: string) => (await withOrg({ orgId: c.orgId }, async (tx) => previewDateMove(tx, { orgId: c.orgId }, await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } }), to))).preview.fingerprint;

/** Every swept page as the signed-in person, by file. Dynamic segments get the public vendor's id or a stranger's. */
async function sweep(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const zero = '00000000-0000-4000-8000-000000000000';
  for (const [file, load] of Object.entries(PAGES)) {
    const params = { org: c.slug, id: file.includes('/vendors/') ? ids.publicVendor : zero, event: zero, photo: zero, kind: 'thumb' };
    const search: Record<string, string> = file.endsWith('/date/page.tsx') ? { to: addDays(wedding, 7) } : file.endsWith('/schedule/page.tsx') ? { edit: ids.task } : {};
    out[file] = await render(await load(), params, search);
  }
  out['vendors/[secret]'] = await render(await PAGES['src/app/o/[org]/wedding/vendors/[id]/page.tsx']!(), { org: c.slug, id: ids.vendor });
  // The template's audit-log CSV, read the way its route reads it (settings/audit/csv/route.ts: requireOrg with
  // 'audit.read', then auditCsv). Called directly rather than by importing the route: `foundation:check-modules` copies
  // the tree with `--exclude audit`, which drops every folder named audit, so an import of that route fails the
  // modules-removed typecheck (CI, PR #5). A viewer without 'audit.read' is refused, as by the route.
  out['audit.csv'] = await requireOrg(c.slug, 'audit.read').then(
    async (ctx) => auditCsv(ctx, await auditFilter({})),
    (e: unknown) => {
      if (e instanceof NavSignal && e.kind === 'notFound') return NOT_FOUND;
      if (e instanceof AuthzError) return FORBIDDEN; // as render.ts get() reports the route's refusal
      throw e;
    },
  );
  out['attachment'] = (await get(attachmentRoute as never, { org: c.slug, id: ids.vendor, attachment: ids.attachment })).text;
  return out;
}

async function exportText(userId: string): Promise<Record<string, string>> {
  const ctx = await actAs(userId, c.slug);
  await db.rateLimit.deleteMany(); // one export an hour per workspace; this test takes one as each partner
  const id = await requestExport(ctx);
  expect(await buildExport(ctx, id, exportTables)).toBe('ready');
  const row = await db.orgExport.findUniqueOrThrow({ where: { id } });
  const file = join(mkdtempSync(join(tmpdir(), 'kw-secrecy-')), 'export.zip');
  writeFileSync(file, row.archive!);
  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
  return Object.fromEntries(names.map((n) => [n, execFileSync('unzip', ['-p', file, n], { encoding: 'utf8' })]));
}

describe('the leak sweep', () => {
  let helper2: string;
  beforeAll(async () => {
    wedding = addDays(today(), 330);
    c = await makeWedding(wedding);
    helper2 = (await addMember(c.orgId, 'member', 'wren@example.test')).id;
    for (const scope of ['schedule_edit', 'budget_edit', 'vendors_edit', 'guests_edit', 'photos_moderate'] as const) await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope } });
    await as(c.a);
    await ok(addCategory(c.slug, { name: 'Catering', estimate: '10,000' }));
    await ok(addCategory(c.slug, { name: `${SECRET} Watch for Rowan`, estimate: '900', privacy: '0' }));
    await ok(addVendor(c.slug, { name: `${SECRET} Glasswing Engravers`, category: 'other', contactName: `${SECRET} Contact`, email: 'engrave@example.test', phone: '', privacy: 'never' }));
    await ok(addVendor(c.slug, { name: 'Fennel & Fig Catering', category: 'caterer', contactName: '', email: '', phone: '' }));
    const [vendor, publicVendor, category, catering] = [await find.vendor(`${SECRET} Glasswing Engravers`), await find.vendor('Fennel & Fig Catering'), await find.category(`${SECRET} Watch for Rowan`), await find.category('Catering')];
    await ok(updateVendor(c.slug, { id: vendor.id, name: vendor.name, category: 'other', contactName: `${SECRET} Contact`, email: '', phone: '', notes: `${SECRET} notes`, deliverables: `${SECRET} deliverables`, arrive: '', depart: '', countEstimate: '', countDueDaysBefore: '', onSite: '', contractTotal: '' }));
    await ok(addTask(c.slug, { title: `${SECRET} Engrave the watch`, leadDays: '10', bufferDays: '20', assigneeId: '', dependsOn: [], privacy: '0' }));
    const task = await find.task(`${SECRET} Engrave the watch`);
    await ok(addTask(c.slug, { title: 'Wrap the gift', leadDays: '1', bufferDays: '5', assigneeId: '', dependsOn: [task.id] }));
    await ok(addExpense(c.slug, { categoryId: catering.id, vendorId: vendor.id, description: `${SECRET} engraving deposit`, amount: '120', paidOn: '', privacy: '0' }));
    await ok(addExpense(c.slug, { categoryId: category.id, vendorId: '', description: `${SECRET} leather strap`, amount: '80', paidOn: '' })); // shared, but its category is not
    await ok(addExpense(c.slug, { categoryId: catering.id, vendorId: publicVendor.id, description: 'Tasting fee', amount: '50', paidOn: '' }));
    await ok(addVendorPayment(c.slug, { vendorId: vendor.id, label: `${SECRET} balance`, amount: '200', dueDaysBefore: '30' }));
    await ok(regenerateBrief(c.slug, { id: vendor.id }));
    // A private task that names a SHARED vendor: the shared vendor's brief must not list it.
    await db.task.update({ where: { id: task.id }, data: { vendorId: publicVendor.id, notes: `${SECRET} note` } });
    await ok(regenerateBrief(c.slug, { id: publicVendor.id }));
    await ok(takeBudgetSnapshot(c.slug, { note: 'After the watch' }));
    const sent = await attachRoute(multipart(`http://${HOST}/o/${c.slug}/wedding/vendors/${vendor.id}/attachments`, 'file', fixture('big.jpg'), { label: `${SECRET} contract page` }, { origin: `http://${HOST}`, host: HOST }), { params: Promise.resolve({ org: c.slug, id: vendor.id }) });
    expect(sent.status).toBe(303);
    // Funding: a pledge toward the private category, paid toward the strap; a second funder toward Catering.
    await ok(addFunder(c.slug, { name: 'Hazel Vale', note: '' }));
    await ok(addFunder(c.slug, { name: 'Aunt Wren Ashby', note: '' }));
    const [hazel, wren] = [await db.funder.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Hazel Vale' } }), await db.funder.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Aunt Wren Ashby' } })];
    await ok(addPledge(c.slug, { funderId: hazel.id, categoryId: category.id, amount: '900' }));
    await ok(addPledge(c.slug, { funderId: hazel.id, categoryId: catering.id, amount: '100' }));
    await ok(addPledge(c.slug, { funderId: wren.id, categoryId: catering.id, amount: '2,000' }));
    const hazelWatch = await db.funderPledge.findFirstOrThrow({ where: { funderId: hazel.id, categoryId: category.id } });
    await ok(recordReceipt(c.slug, { pledgeId: hazelWatch.id, amount: '900', receivedOn: '', note: '' }));
    await ok(payFromPledge(c.slug, { pledgeId: hazelWatch.id, expenseId: (await find.expense(`${SECRET} leather strap`)).id, amount: '80' }));
    await ok(linkFunder(c.slug, { funderId: hazel.id, userId: helper2 }));
    // A pending date move: Rowan is shown its preview, which lists every task.
    await ok(proposeDateMove(c.slug, { to: addDays(wedding, 7), fingerprint: await fp(addDays(wedding, 7)) }));
    const attachment = await db.vendorAttachment.findFirstOrThrow({ where: { orgId: c.orgId } });
    ids = { task: task.id, vendor: vendor.id, publicVendor: publicVendor.id, category: category.id, catering: catering.id, spend: (await find.expense(`${SECRET} engraving deposit`)).id, strap: (await find.expense(`${SECRET} leather strap`)).id, attachment: attachment.id, funderHelper: helper2 };
  });

  it('the sweep covers every Knotwork page (by glob) and is not blind: Juniper sees every secret', async () => {
    expect(Object.keys(PAGES).filter((f) => f.includes('/wedding/')).length).toBeGreaterThanOrEqual(24);
    expect(Object.keys(PAGES)).toContain('src/app/o/[org]/wedding/funding/page.tsx');
    await as(c.a);
    const pages = await sweep();
    const has = (file: string) => pages[`src/app/o/[org]/wedding/${file}/page.tsx`]!;
    expect(has('schedule')).toContain(`${SECRET} Engrave the watch`);
    expect(has('budget')).toContain(`${SECRET} Watch for Rowan`);
    expect(has('budget')).toContain(`${SECRET} engraving deposit`);
    expect(has('vendors')).toContain(`${SECRET} Glasswing Engravers`);
    expect(pages['vendors/[secret]']).toContain(`${SECRET} deliverables`);
    expect(pages['vendors/[secret]']).toContain('Private to you');
    expect(pages.attachment).not.toBe(NOT_FOUND);
    expect(has('funding')).toContain(`${SECRET} Watch for Rowan`);
  });

  for (const who of ['the other partner', 'a helper with every grant', 'a helper linked to a funder'] as const) {
    it(`no page, route or feed shows ${who} a private label`, async () => {
      await as(who === 'the other partner' ? c.b : who === 'a helper with every grant' ? c.helper : ids.funderHelper);
      const pages = await sweep();
      for (const [file, html] of Object.entries(pages)) expect(html, `${who}: ${file}`).not.toContain(SECRET);
      expect(pages['vendors/[secret]']).toBe(NOT_FOUND);
      expect(pages.attachment).toBe(NOT_FOUND);
      if (who === 'a helper linked to a funder') return;
      const has = (file: string) => pages[`src/app/o/[org]/wedding/${file}/page.tsx`]!;
      // The masked lines are there, each saying whose and when; the totals are the real totals.
      expect(has('schedule')).toContain('Private task');
      expect(has('schedule')).toContain('after Private task'); // the shared task that waits for it
      expect(has('budget')).toContain('Private category');
      expect(has('budget')).toContain('Private spend');
      expect(has('budget')).toContain('$10,900.00'); // estimates: Catering 10,000 + the private 900
      expect(has('budget')).toContain('$250.00'); // actuals: 120 + 80 + 50, two of them private
      expect(has('budget')).toContain('The totals include');
      expect(has('vendors')).toContain('Private vendor');
      expect(has('funding')).toContain('Pledged $1,000.00'); // Hazel's two pledges, one toward the private category
      if (who === 'the other partner') expect(has('approvals')).toContain('Private task'); // the date-move preview
    });
  }

  it('a helper linked to a funder sees that funder only: its pledges, what arrived, what it paid; nothing else of the budget', async () => {
    await as(ids.funderHelper);
    const pages = await sweep();
    const funding = pages['src/app/o/[org]/wedding/funding/page.tsx']!;
    expect(funding).toContain('What you are giving toward');
    expect(funding).toContain('Hazel Vale');
    expect(funding).toContain('Catering'); // the shared category Hazel pledged toward, by name
    expect(funding).toContain('Private category'); // the other, masked
    expect(funding).toContain('Pledged $1,000.00 · received $900.00 · spent $80.00');
    expect(funding).not.toContain('Aunt Wren'); // another funder
    expect(funding).not.toContain('$2,000.00'); // another funder's pledge
    expect(funding).not.toContain('Tasting fee'); // a spend their money did not pay
    expect(funding).not.toContain('$10,000.00'); // a category estimate
    for (const page of ['budget', 'vendors', 'flags', 'approvals', 'helpers', 'gifts', 'guests']) expect(pages[`src/app/o/[org]/wedding/${page}/page.tsx`], page).toBe(NOT_FOUND);
    const activity = pages['src/app/o/[org]/wedding/activity/page.tsx']!;
    for (const s of ['Catering', 'Hazel', 'Aunt Wren', 'Tasting fee', 'a pledge', 'money received', 'a spend', 'a budget category']) expect(activity, s).not.toContain(s);
  });

  it('the change log as stored holds no private label, before or after; the masked entries keep who and when', async () => {
    const all = await log(c.orgId);
    expect(JSON.stringify(all.map((e) => e.data))).not.toContain(SECRET);
    const masked = all.filter((e) => (e.data as { private?: boolean }).private);
    expect(masked.length).toBeGreaterThanOrEqual(10); // the category, vendor and its edit, tasks, spends, payment, brief, attachment, pledge, receipt, allocation
    for (const e of masked) {
      expect(e.data).toMatchObject({ label: 'a private item', before: null, after: null });
      expect(e.actorUserId).toBe(c.a);
    }
    expect(masked.map((e) => e.action)).toEqual(expect.arrayContaining(['knotwork.category.created', 'knotwork.vendor.created', 'knotwork.vendor.updated', 'knotwork.task.created', 'knotwork.expense.created', 'knotwork.payment.created', 'knotwork.brief.generated', 'knotwork.attachment.added', 'knotwork.pledge.created', 'knotwork.receipt.created', 'knotwork.allocation.created']));
  });

  it('the data export holds no private label for either partner, and its amounts still add up', async () => {
    for (const userId of [c.a, c.b]) {
      const files = await exportText(userId);
      for (const [name, text] of Object.entries(files)) expect(text, name).not.toContain(SECRET);
      const rows = (prefix: string) => Object.entries(files).find(([n]) => n.startsWith(prefix))![1].trim().split('\n').map((l) => JSON.parse(l));
      const expenses = rows('Expense.') as { amountCents: number; description: string }[];
      expect(expenses.reduce((n, e) => n + e.amountCents, 0)).toBe(25_000);
      expect(expenses.map((e) => e.description).sort()).toEqual(['Private spend', 'Private spend', 'Tasting fee']);
      expect(rows('Vendor.').map((v: { name: string }) => v.name).sort()).toEqual(['Fennel & Fig Catering', 'Private vendor']);
    }
  });

  it('stored artifacts are written for nobody: the snapshot line and the shared vendor\'s brief', async () => {
    const snap = await db.budgetSnapshot.findFirstOrThrow({ where: { orgId: c.orgId } });
    expect(JSON.stringify(snap.totals)).not.toContain(SECRET);
    expect((snap.totals as { estimateCents: number }).estimateCents).toBe(1_090_000);
    const brief = await db.vendorBrief.findFirstOrThrow({ where: { orgId: c.orgId, vendorId: ids.publicVendor } });
    expect(brief.body).not.toContain(SECRET);
  });

  it('a ref to a hidden item is a 404 to the other partner and to helpers, like a row of another workspace', async () => {
    for (const userId of [c.b, c.helper]) {
      await as(userId);
      const nf = async (p: Promise<unknown>) => expect(await outcome(p), userId).toMatchObject({ nav: 'notFound' });
      await nf(setTaskStatus(c.slug, { id: ids.task, status: 'done' }));
      await nf(updateTask(c.slug, { id: ids.task, title: 'x', leadDays: 1, bufferDays: 1, assigneeId: '', dependsOn: [] }));
      await nf(removeTask(c.slug, { id: ids.task }));
      await nf(addTask(c.slug, { title: 'x', leadDays: 1, bufferDays: 1, assigneeId: '', dependsOn: [ids.task] }));
      await nf(updateVendor(c.slug, { id: ids.vendor, name: 'x', category: 'dj', contactName: '', email: '', phone: '', notes: '', deliverables: '', arrive: '', depart: '', countEstimate: '', countDueDaysBefore: '', onSite: '', contractTotal: '' }));
      await nf(regenerateBrief(c.slug, { id: ids.vendor }));
      await nf(addExpense(c.slug, { categoryId: ids.category, vendorId: '', description: 'x', amount: '1', paidOn: '' }));
      await nf(addExpense(c.slug, { categoryId: ids.catering, vendorId: ids.vendor, description: 'x', amount: '1', paidOn: '' }));
      await nf(addVendorPayment(c.slug, { vendorId: ids.vendor, label: 'x', amount: '1', dueDaysBefore: '1' }));
      const pay = await db.vendorPayment.findFirstOrThrow({ where: { vendorId: ids.vendor } });
      await nf(payVendorPayment(c.slug, { id: pay.id, categoryId: ids.catering, paidOn: '' }));
      await nf(setTaskPrivacy(c.slug, { id: ids.task, privacy: '' }));
      await nf(setVendorPrivacy(c.slug, { id: ids.vendor, privacy: '' }));
      await nf(setCategoryPrivacy(c.slug, { id: ids.category, privacy: '' }));
      await nf(setExpensePrivacy(c.slug, { id: ids.spend, privacy: '' }));
      const post = await attachRoute(multipart(`http://${HOST}/o/${c.slug}/wedding/vendors/${ids.vendor}/attachments`, 'file', fixture('big.jpg'), {}, { origin: `http://${HOST}`, host: HOST }), { params: Promise.resolve({ org: c.slug, id: ids.vendor }) }).catch((e) => e);
      expect(String(post), userId).toMatch(/notFound/);
    }
    await as(c.b);
    await expect(outcome(proposeBooking(c.slug, { id: ids.vendor }))).resolves.toMatchObject({ nav: 'notFound' });
  });
});

describe('reveal points, early reveal and who may keep a secret', () => {
  beforeEach(async () => {
    wedding = addDays(today(), 60);
    c = await makeWedding(wedding);
  });

  it('a task private until the wedding day shows itself on that day, with no write; one until "never" waits for its owner', async () => {
    await as(c.a);
    await ok(addTask(c.slug, { title: 'Order the surprise cake', leadDays: '1', bufferDays: '0', assigneeId: '', dependsOn: [], privacy: '0' }));
    await ok(addTask(c.slug, { title: 'Hide the love letter', leadDays: '1', bufferDays: '0', assigneeId: '', dependsOn: [], privacy: 'never' }));
    const schedule = () => render(require_('schedule'), { org: c.slug });
    await as(c.b);
    expect(await schedule()).not.toContain('surprise cake');
    goToDay(addDays(wedding, -1));
    await as(c.b);
    expect(await schedule()).not.toContain('surprise cake');
    const before = (await log(c.orgId)).length;
    goToDay(wedding);
    await as(c.b);
    const html = await schedule();
    expect(html).toContain('Order the surprise cake');
    expect(html).not.toContain('love letter');
    expect((await log(c.orgId)).length).toBe(before); // derived: nothing was written
    await as(c.a);
    await ok(setTaskPrivacy(c.slug, { id: (await find.task('Hide the love letter')).id, privacy: '' }));
    await as(c.b);
    expect(await schedule()).toContain('Hide the love letter');
    const revealed = (await log(c.orgId)).at(-1)!;
    expect(revealed).toMatchObject({ action: 'knotwork.task.revealed', actorUserId: c.a });
    expect(revealed.data).toMatchObject({ label: 'Hide the love letter', after: { private: false } });
  });

  it('the reveal day moves with the wedding (rule 1: an offset, never a stored date)', async () => {
    await as(c.a);
    await ok(addCategory(c.slug, { name: 'Honeymoon surprise', estimate: '500', privacy: '-7' }));
    const row = await find.category('Honeymoon surprise');
    expect(row).toMatchObject({ privateToId: c.a, revealDays: -7 });
    goToDay(addDays(wedding, -7));
    await as(c.b);
    expect(await render(require_('budget'), { org: c.slug })).toContain('Honeymoon surprise');
  });

  it('only a partner keeps a secret; a reveal point already past is refused; a private task is assigned only to its owner', async () => {
    await db.helperGrant.create({ data: { orgId: c.orgId, userId: c.helper, scope: 'schedule_edit' } });
    await as(c.helper);
    await refused(addTask(c.slug, { title: 'x', leadDays: 1, bufferDays: 1, assigneeId: '', dependsOn: [], privacy: '0' }), /Only the two partners/);
    const t = await db.task.findFirstOrThrow({ where: { orgId: c.orgId, key: 'order-cake' } });
    await refused(setTaskPrivacy(c.slug, { id: t.id, privacy: '0' }), /Only the two partners/);
    await as(c.a);
    await refused(addTask(c.slug, { title: 'x', leadDays: 1, bufferDays: 1, assigneeId: '', dependsOn: [], privacy: '-61' }), /already passed/);
    await refused(addTask(c.slug, { title: 'x', leadDays: 1, bufferDays: 1, assigneeId: c.b, dependsOn: [], privacy: '0' }), /assigned to you, or to nobody/);
    await refused(addTask(c.slug, { title: 'x', leadDays: 1, bufferDays: 1, assigneeId: '', dependsOn: [], privacy: 'soon' }), /Pick when it should be revealed/);
    await ok(setTaskPrivacy(c.slug, { id: t.id, privacy: '0' }));
    await refused(updateTask(c.slug, { id: t.id, title: t.title, leadDays: t.leadDays, bufferDays: t.bufferDays, assigneeId: c.helper, dependsOn: [] }), /assigned to you, or to nobody/);
    await ok(setTaskPrivacy(c.slug, { id: t.id, privacy: '' }));
    await refused(setTaskPrivacy(c.slug, { id: t.id, privacy: '' }), /already shared/);
    // The database half: only an owner of the workspace can be an item's owner.
    await expect(db.task.update({ where: { id: t.id }, data: { privateToId: c.helper } })).rejects.toThrow(/only a partner/);
    await expect(db.task.update({ where: { id: t.id }, data: { privateToId: null, revealDays: 3 } })).rejects.toThrow(/Task_reveal_check/);
  });

  it('an edit by the other partner keeps a dependency on a hidden task; a cycle through one names it "Private task"', async () => {
    await as(c.a);
    await ok(addTask(c.slug, { title: 'ZQX hidden step', leadDays: '1', bufferDays: '10', assigneeId: '', dependsOn: [], privacy: '0' }));
    const hidden = await find.task('ZQX hidden step');
    const cake = await db.task.findFirstOrThrow({ where: { orgId: c.orgId, key: 'order-cake' } });
    await ok(addTask(c.slug, { title: 'Wrap it', leadDays: '1', bufferDays: '5', assigneeId: '', dependsOn: [hidden.id] }));
    const wrap = await find.task('Wrap it');
    await ok(updateTask(c.slug, { id: hidden.id, title: hidden.title, leadDays: 1, bufferDays: 10, assigneeId: '', dependsOn: [cake.id] }));
    await as(c.b);
    // Wrap it waits for the hidden step; Rowan's form does not show that, and saving it does not drop it.
    await ok(updateTask(c.slug, { id: wrap.id, title: 'Wrap it', leadDays: 2, bufferDays: 5, assigneeId: '', dependsOn: [] }));
    expect((await db.taskDependency.findMany({ where: { taskId: wrap.id } })).map((d) => d.dependsOnId)).toEqual([hidden.id]);
    // cake → Wrap it → hidden step → cake is a circle: refused, naming the hidden task only as "Private task".
    const o = await outcome(updateTask(c.slug, { id: cake.id, title: cake.title, leadDays: cake.leadDays, bufferDays: cake.bufferDays, assigneeId: '', dependsOn: [wrap.id] }));
    expect(o.error).toMatch(/circle/);
    expect(o.error).toContain('Private task');
    expect(o.error).not.toContain('ZQX');
  });

  it('marking an existing item private hides its earlier entries on the activity page; the stored entries stay as written (ADR-001)', async () => {
    await as(c.a);
    await ok(addVendor(c.slug, { name: 'ZQY Midnight Fireworks', category: 'other', contactName: '', email: '', phone: '' }));
    const v = await find.vendor('ZQY Midnight Fireworks');
    await ok(setVendorPrivacy(c.slug, { id: v.id, privacy: '0' }));
    await as(c.b);
    expect(await render(require_('activity'), { org: c.slug })).not.toContain('ZQY');
    expect(JSON.stringify((await log(c.orgId)).map((e) => e.data))).toContain('ZQY'); // the "created" entry, written while shared
    expect((await log(c.orgId)).at(-1)).toMatchObject({ action: 'knotwork.vendor.hidden', data: { label: 'a private item', before: null, after: null } });
  });

  it('an owner who is no longer a partner holds no secret (D-96)', async () => {
    await as(c.a);
    await ok(addVendor(c.slug, { name: 'Glass Slipper Shoes', category: 'attire', contactName: '', email: '', phone: '', privacy: 'never' }));
    await as(c.b);
    expect(await render(require_('vendors'), { org: c.slug })).not.toContain('Glass Slipper');
    await db.membership.update({ where: { orgId_userId: { orgId: c.orgId, userId: c.a } }, data: { role: 'member' } });
    await as(c.b);
    expect(await render(require_('vendors'), { org: c.slug })).toContain('Glass Slipper');
  });
});

describe('a designated action on a private item cannot stay private (rule 2)', () => {
  beforeEach(async () => {
    wedding = addDays(today(), 200);
    c = await makeWedding(wedding);
    await as(c.a);
    await ok(addCategory(c.slug, { name: 'Surprise band', estimate: '3,000', privacy: '0' }));
    await ok(addVendor(c.slug, { name: 'Tin Roof Strings', category: 'dj', contactName: '', email: '', phone: '', privacy: '0' }));
  });

  it('proposing to book a private vendor reveals it to the approver first, and it cannot be made private again', async () => {
    const v = await find.vendor('Tin Roof Strings');
    await ok(proposeBooking(c.slug, { id: v.id }));
    expect(await find.vendor('Tin Roof Strings')).toMatchObject({ privateToId: null, revealDays: null });
    const entries = (await log(c.orgId)).slice(-2);
    expect(entries.map((e) => e.action)).toEqual(['knotwork.vendor.revealed', 'knotwork.request.proposed']);
    expect(entries[0]!.data).toMatchObject({ label: 'Tin Roof Strings', why: 'proposed' });
    await as(c.b);
    expect(await render(require_('approvals'), { org: c.slug })).toContain('Book Tin Roof Strings');
    expect(await render(require_('vendors'), { org: c.slug })).toContain('Tin Roof Strings');
    await as(c.a);
    await refused(setVendorPrivacy(c.slug, { id: v.id, privacy: '0' }), /been through an approval/);
  });

  it('proposing to sign a private vendor\'s contract reveals it too', async () => {
    const v = await find.vendor('Tin Roof Strings');
    await ok(proposeContract(c.slug, { id: v.id, total: '2,400' }));
    expect((await find.vendor('Tin Roof Strings')).privateToId).toBeNull();
  });

  it('a spend over the threshold cannot be private; proposing one into a private category, or to a private vendor, reveals them', async () => {
    const [cat, v] = [await find.category('Surprise band'), await find.vendor('Tin Roof Strings')];
    await refused(addExpense(c.slug, { categoryId: cat.id, vendorId: '', description: 'Band deposit', amount: '600', paidOn: '', privacy: '0' }), /needs both of you, so it cannot be private/);
    expect(await find.category('Surprise band')).toMatchObject({ privateToId: c.a }); // a refusal reveals nothing
    await ok(addExpense(c.slug, { categoryId: cat.id, vendorId: v.id, description: 'Band deposit', amount: '600', paidOn: '' }));
    expect(await find.category('Surprise band')).toMatchObject({ privateToId: null });
    expect(await find.vendor('Tin Roof Strings')).toMatchObject({ privateToId: null });
    await as(c.b);
    expect(await render(require_('approvals'), { org: c.slug })).toContain('Band deposit (Surprise band)');
    await as(c.a);
    await refused(setCategoryPrivacy(c.slug, { id: cat.id, privacy: '0' }), /been through an approval/);
  });

  it('a spend at or under the threshold may be private; one that went through consent may not; the database refuses both designated cases', async () => {
    const cat = await find.category('Surprise band');
    await ok(addExpense(c.slug, { categoryId: cat.id, vendorId: '', description: 'Sheet music', amount: '40', paidOn: '', privacy: '0' }));
    expect(await find.expense('Sheet music')).toMatchObject({ privateToId: c.a, revealDays: 0 });
    const v = await find.vendor('Tin Roof Strings');
    await expect(db.vendor.update({ where: { id: v.id }, data: { status: 'booked' } })).rejects.toThrow();
    const e = await find.expense('Sheet music');
    const r = await db.consentRequest.create({ data: { orgId: c.orgId, kind: 'spend', payload: {}, summary: 'x', proposerId: c.a, expiresAt: new Date(now().getTime() + 86_400_000) } });
    await expect(db.expense.update({ where: { id: e.id }, data: { requestId: r.id } })).rejects.toThrow();
  });

  it('in solo mode a designated action still reveals (the request stays on the approvals page for the partner who joins later)', async () => {
    const org = await makeOrg('solo-secret');
    const owner = (await addMember(org.id, 'owner', 'solo@example.test')).id;
    await as(owner);
    const { createWedding } = await import('@/app/o/[org]/wedding/actions');
    await ok(createWedding(org.slug, { title: 'Solo', date: addDays(today(), 200), timeZone: 'America/Chicago' }));
    await ok(addVendor(org.slug, { name: 'Lone Piper', category: 'dj', contactName: '', email: '', phone: '', privacy: 'never' }));
    const v = await db.vendor.findFirstOrThrow({ where: { orgId: org.id } });
    await ok(proposeBooking(org.slug, { id: v.id }));
    expect(await db.vendor.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'booked', privateToId: null });
  });
});

describe('solo mode (D-33, D-97): with one partner the helpers are the others', () => {
  it('a helper never sees the only partner\'s secret; when the second partner joins, it stays private to the first', async () => {
    const org = await makeOrg('solo-helpers');
    const owner = (await addMember(org.id, 'owner', 'solo-two@example.test')).id;
    const helper = (await addMember(org.id, 'member', 'helper@example.test')).id;
    await db.helperGrant.create({ data: { orgId: org.id, userId: helper, scope: 'vendors_view' } });
    await as(owner);
    const { createWedding } = await import('@/app/o/[org]/wedding/actions');
    await ok(createWedding(org.slug, { title: 'Solo', date: addDays(today(), 200), timeZone: 'America/Chicago' }));
    await ok(addVendor(org.slug, { name: 'Moonlit Calligraphy', category: 'other', contactName: '', email: '', phone: '', privacy: '0' }));
    const vendors = () => render(require_('vendors'), { org: org.slug });
    await as(helper);
    expect(await vendors()).not.toContain('Moonlit');
    expect(await vendors()).toContain('Private vendor');
    const second = (await addMember(org.id, 'owner', 'second@example.test')).id;
    await as(second);
    expect(await vendors()).not.toContain('Moonlit');
    await as(owner);
    expect(await vendors()).toContain('Moonlit Calligraphy');
  });
});

// The page modules by short name, for the tests outside the sweep.
const PAGE_FILE: Record<string, string> = Object.fromEntries(['schedule', 'budget', 'vendors', 'activity', 'approvals', 'funding'].map((p) => [p, `src/app/o/[org]/wedding/${p}/page.tsx`]));
const loaded: Record<string, Awaited<ReturnType<(typeof PAGES)[string]>>> = {};
beforeAll(async () => {
  for (const [k, f] of Object.entries(PAGE_FILE)) loaded[k] = await PAGES[f]!();
});
const require_ = (name: string) => loaded[name]!;
