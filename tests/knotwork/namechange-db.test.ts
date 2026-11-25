import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as nc from '@/app/o/[org]/wedding/name-change/actions';
import { exportTables } from '@/app/export-hooks';
import { now } from '@/core/clock';
import { buildExport, requestExport } from '@/core/tenancy/export';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { actAs } from '../helpers/org';
import { as, db, log, makeWedding, ok, refused, snapshot, type Couple } from './db';
import { NOT_FOUND, PAGES, render } from './render';

// P1-4, the name-change sequence through the real actions and page: one partner's ordered workflow from the rules
// files, gated in the store (a step starts or is marked done only when what it waits for is done and the documents it
// needs are held), private to that partner unless shared (D-114), with days of fact only (rule 1).
const today = () => todayIn('America/Chicago', now());
const PAGE = 'src/app/o/[org]/wedding/name-change/page.tsx';
let c: Couple;
const page = async () => render(await PAGES[PAGE]!(), { org: c.slug });
const mine = () => db.nameChange.findFirstOrThrow({ where: { orgId: c.orgId, userId: c.a }, include: { steps: { orderBy: { step: 'asc' } }, artifacts: { orderBy: { artifact: 'asc' } } } });
const step = (s: string, op: 'start' | 'finish' | 'stop' | 'reopen') => nc.moveNameChangeStep(c.slug, { step: s, op });
const doc = (a: string, op: 'hold' | 'release' = 'hold') => nc.holdNameChangeArtifact(c.slug, { artifact: a, op });

beforeEach(async () => {
  c = await makeWedding(addDays(today(), 330));
});

describe('the ordered workflow, gated in the store', () => {
  it('a step is refused until its documents are held and what it waits for is done; each refusal names what is missing and writes nothing', async () => {
    await as(c.a);
    await ok(nc.startNameChange(c.slug, { jurisdiction: 'us-ca' }));
    const before = await snapshot();
    await refused(step('ssa', 'start'), /Mark the documents it needs as held first: Certified copy of your marriage certificate; A current photo ID in your previous name\./);
    await refused(step('dmv', 'finish'), /Finish the steps it waits for first: Update your name with the Social Security Administration\./);
    await refused(doc('new-ss-card'), /comes out of a step that is not done yet: Update your name with the Social Security Administration/);
    await refused(step('nope', 'start'), /not in this workflow/);
    expect(await snapshot()).toBe(before);

    await ok(doc('marriage-certificate'));
    await ok(doc('proof-of-identity'));
    await ok(step('ssa', 'start'));
    await refused(doc('marriage-certificate', 'release'), /A step in progress still needs it: Update your name with the Social Security Administration/);
    await ok(step('ssa', 'finish'));
    await refused(step('voter', 'start'), /Finish the steps it waits for first: Update your driver's license or ID card at the DMV/); // California's extra step
    await ok(doc('new-ss-card'));
    await refused(step('ssa', 'reopen'), /You already hold what this step produced/);
    await ok(step('dmv', 'finish'));
    const row = await mine();
    expect(row.steps.map((s) => [s.step, s.status, s.completedOn?.toISOString().slice(0, 10) ?? null])).toEqual([['dmv', 'done', today()], ['ssa', 'done', today()]]);
    expect(row.artifacts.map((a) => a.artifact)).toEqual(['marriage-certificate', 'new-ss-card', 'proof-of-identity']);
    // The page reads it back: progress, what is ready, and each step's "from" day from the wedding date.
    const html = await page();
    expect(html).toContain('2 of 8 steps done');
    expect(html).toContain('Illustrative only, not legal advice');
    expect(html).toContain(`From ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${addDays(addDays(today(), 330), 7)}T00:00:00Z`))}`);
  });

  it('stop and reopen keep the gating true: a later step that has begun, or a held product, holds a step done', async () => {
    await as(c.a);
    await ok(nc.startNameChange(c.slug, { jurisdiction: 'generic' }));
    for (const a of ['marriage-certificate', 'proof-of-identity']) await ok(doc(a));
    await ok(step('ssa', 'finish'));
    await ok(doc('new-ss-card'));
    await ok(step('employer', 'start'));
    await refused(step('ssa', 'reopen'), /A later step that relies on it has already begun: Tell your employer's payroll and benefits team/);
    await ok(step('employer', 'stop'));
    await ok(doc('new-ss-card', 'release'));
    await ok(step('ssa', 'reopen'));
    const row = await mine();
    expect(row.steps.map((s) => [s.step, s.status, s.completedOn])).toEqual([['ssa', 'started', null]]); // reopened: no longer a day it was done
    await expect(db.nameChangeStep.update({ where: { id: row.steps[0]!.id }, data: { status: 'done' } })).rejects.toThrow(/NameChangeStep_done_check/);
  });

  it('the rules can change only before any step has started; documents the new rules do not name are let go', async () => {
    await as(c.a);
    await ok(nc.startNameChange(c.slug, { jurisdiction: 'us-ny' }));
    await refused(nc.startNameChange(c.slug, { jurisdiction: 'generic' }), /already have a name change/);
    await refused(nc.changeJurisdiction(c.slug, { jurisdiction: 'atlantis' }), /Pick one of the places on the list/);
    for (const a of ['marriage-certificate', 'proof-of-identity']) await ok(doc(a));
    await ok(nc.changeJurisdiction(c.slug, { jurisdiction: 'us-tx' }));
    expect((await mine()).jurisdiction).toBe('us-tx');
    await ok(step('ssa', 'start'));
    await refused(nc.changeJurisdiction(c.slug, { jurisdiction: 'generic' }), /already started steps/);
    await refused(nc.removeNameChange(c.slug, { confirm: '' }), /Tick the box/);
    await ok(nc.removeNameChange(c.slug, { confirm: 'on' }));
    expect(await db.nameChange.count({ where: { orgId: c.orgId } })).toBe(0);
    expect(await db.nameChangeStep.count({ where: { orgId: c.orgId } })).toBe(0);
  });
});

describe('private to its partner unless shared (D-114)', () => {
  it('the other partner and helpers see nothing of it; the change log is written masked; sharing shows it read-only', async () => {
    await as(c.a);
    await ok(nc.startNameChange(c.slug, { jurisdiction: 'us-ca' }));
    await ok(doc('marriage-certificate'));
    expect(await page()).toContain('Private to you');

    await as(c.b);
    let html = await page();
    expect(html).not.toContain('Following:'); // (California is on his own form's list of places, so it is not the marker)
    expect(html).not.toContain('marriage certificate');
    expect(html).not.toContain('juniper@example.test');
    expect(html).toContain('Start my name change'); // only his own, not started
    // Rowan's actions act on his own name change only: there is no id to post that could name Juniper's.
    await refused(doc('proof-of-identity'), /Start your name change first/);
    await as(c.helper);
    expect(await page()).toBe(NOT_FOUND);
    await refused(nc.startNameChange(c.slug, { jurisdiction: 'generic' }), /do not have access/);

    // Every entry about it was written without what it is: "a private item", who, when, the field names.
    const entries = (await log(c.orgId)).filter((e) => e.action.startsWith('knotwork.namechange.'));
    expect(entries.map((e) => e.action)).toEqual(['knotwork.namechange.created', 'knotwork.namechange.updated']);
    for (const e of entries) expect(e.data).toMatchObject({ label: 'a private item', before: null, after: null, private: true });
    expect(JSON.stringify(entries.map((e) => e.data))).not.toMatch(/California|us-ca|marriage/);
    await as(c.b);
    expect(await render(await PAGES['src/app/o/[org]/wedding/activity/page.tsx']!(), { org: c.slug })).not.toMatch(/California|marriage certificate/);

    // Shared: Rowan reads it, with no button of his own on it; the share itself is logged with its label.
    await as(c.a);
    await ok(nc.shareNameChange(c.slug, { shared: 'on' }));
    await as(c.b);
    html = await page();
    expect(html).toContain('juniper@example.test&#x27;s name change (shared with you)');
    expect(html).toContain('Update your name with the Social Security Administration');
    expect(html.split('(shared with you)')[1]).not.toContain('Start: ');
    const shared = (await log(c.orgId)).find((e) => e.action === 'knotwork.namechange.shared')!;
    expect(shared.data).toMatchObject({ label: 'Name change (California (illustrative))', after: { shared: true } });
    await as(c.helper);
    expect(await page()).toBe(NOT_FOUND); // helpers never, shared or not

    // Private again: the next entries are masked again, and Rowan's page no longer shows it.
    await as(c.a);
    await ok(nc.shareNameChange(c.slug, { shared: '' }));
    await ok(doc('proof-of-identity'));
    expect((await log(c.orgId)).at(-1)!.data).toMatchObject({ label: 'a private item', private: true });
    await as(c.b);
    expect(await page()).not.toContain('juniper@example.test');
  });

  it('the data export is built for nobody: an unshared name change keeps its ids and days, not what it is', async () => {
    await as(c.a);
    await ok(nc.startNameChange(c.slug, { jurisdiction: 'us-ca' }));
    for (const a of ['marriage-certificate', 'proof-of-identity']) await ok(doc(a));
    await ok(step('ssa', 'finish'));
    const text = async () => {
      const ctx = await actAs(c.a, c.slug);
      await db.rateLimit.deleteMany();
      const id = await requestExport(ctx);
      expect(await buildExport(ctx, id, exportTables)).toBe('ready');
      const file = join(mkdtempSync(join(tmpdir(), 'kw-namechange-')), 'export.zip');
      writeFileSync(file, (await db.orgExport.findUniqueOrThrow({ where: { id } })).archive!);
      const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
      return Object.fromEntries(names.map((n) => [n.replace(/\.\w+$/, ''), execFileSync('unzip', ['-p', file, n], { encoding: 'utf8' })]));
    };
    let files = await text();
    const rows = (name: string) => files[Object.keys(files).find((n) => n.endsWith(name))!]!.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows('NameChange')).toEqual([expect.objectContaining({ userId: c.a, jurisdiction: '', shared: false })]);
    expect(rows('NameChangeStep')).toEqual([expect.objectContaining({ step: '', status: 'done', completedOn: expect.stringContaining(today()) })]);
    expect(rows('NameChangeArtifact').map((r) => r.artifact)).toEqual(['', '']);
    await as(c.a);
    await ok(nc.shareNameChange(c.slug, { shared: 'on' }));
    files = await text();
    expect(rows('NameChange')).toEqual([expect.objectContaining({ jurisdiction: 'us-ca', shared: true })]);
    expect(rows('NameChangeStep').map((r) => r.step)).toEqual(['ssa']);
  });

  it('only a partner has one: the database refuses one for a helper or for someone outside the workspace', async () => {
    await expect(db.nameChange.create({ data: { orgId: c.orgId, userId: c.helper, jurisdiction: 'generic' } })).rejects.toThrow(/only a partner/);
    const other = await db.org.create({ data: { slug: 'other-couple', name: 'Other' } });
    await expect(db.nameChange.create({ data: { orgId: other.id, userId: c.a, jurisdiction: 'generic' } })).rejects.toThrow(/only a partner/);
    await as(c.a);
    await ok(nc.startNameChange(c.slug, { jurisdiction: 'generic' }));
    const row = await mine();
    await expect(db.nameChangeStep.create({ data: { orgId: other.id, nameChangeId: row.id, step: 'ssa', status: 'started' } })).rejects.toThrow(/same workspace/);
    await expect(db.nameChangeArtifact.create({ data: { orgId: c.orgId, nameChangeId: row.id, artifact: 'Not A Key' } })).rejects.toThrow(/NameChangeArtifact_artifact_check/);
  });
});
