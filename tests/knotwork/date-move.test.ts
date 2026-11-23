import { beforeEach, describe, expect, it } from 'vitest';
import { approveRequest, proposeBooking, proposeDateMove, setTaskStatus, updateTask } from '@/app/o/[org]/wedding/actions';
import { advanceClock, now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, dayOfDb, diffDays, todayIn } from '@/lib/knotwork/days';
import { computeSchedule } from '@/lib/knotwork/schedule/engine';
import { loadTasks, previewDateMove, toPlan } from '@/lib/knotwork/schedule/store';
import { DEFAULT_TEMPLATE } from '@/lib/knotwork/schedule/template';
import { as, db, log, makeWedding, ok, refused, snapshot, type Couple } from './db';

// PRD P0-1: "Date move → full re-baseline with a previewed cascade ... commit is atomic", and the success metric
// "a scripted date move re-baselines with zero orphaned tasks". The move is designated (P0-2), so the commit is the
// partner's approval.
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let from: string;
let to: string;

const preview = async (target: string) => {
  const wedding = await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } });
  return withOrg({ orgId: c.orgId }, (tx) => previewDateMove(tx, { orgId: c.orgId }, wedding, target));
};
const pendingMove = () => db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'change_date', status: 'pending' } });

beforeEach(async () => {
  from = addDays(today(), 330);
  to = addDays(from, 42); // six weeks later
  c = await makeWedding(from);
});

describe('creating the wedding', () => {
  it('lays down the default template, its dependencies and a first baseline', async () => {
    expect(await db.task.count({ where: { orgId: c.orgId } })).toBe(DEFAULT_TEMPLATE.length);
    expect(await db.taskDependency.count({ where: { orgId: c.orgId } })).toBe(DEFAULT_TEMPLATE.reduce((n, t) => n + t.dependsOn.length, 0));
    const b = await db.scheduleBaseline.findMany({ where: { orgId: c.orgId } });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: 'initial', requestId: null });
    expect(dayOfDb(b[0]!.toDate)).toBe(from);
  });
  it('a second wedding in the same workspace is refused', async () => {
    const { createWedding } = await import('@/app/o/[org]/wedding/actions');
    await refused(createWedding(c.slug, { title: 'Again', date: from, timeZone: '' }), /already has a wedding/);
  });
});

describe('moving the date six weeks', () => {
  it('proposing changes nothing but the request; the date moves only when the partner approves', async () => {
    const p = await preview(to);
    expect(p.preview.deltaDays).toBe(42);
    await ok(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }));
    expect(dayOfDb((await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } })).date)).toBe(from); // not yet
    expect(await db.scheduleBaseline.count({ where: { orgId: c.orgId } })).toBe(1);

    const r = await pendingMove();
    await as(c.b);
    await ok(approveRequest(c.slug, { id: r.id, fingerprint: p.preview.fingerprint }));
    const w = await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } });
    expect(dayOfDb(w.date)).toBe(to);
    expect(w.dateRequestId).toBe(r.id);
  });

  it('re-baselines every task by exactly 42 days, with zero orphans', async () => {
    const before = await preview(to);
    const rows = await withOrg({ orgId: c.orgId }, (tx) => loadTasks(tx, { orgId: c.orgId }));
    const was = computeSchedule(toPlan(rows), from, today()).tasks!;
    await ok(proposeDateMove(c.slug, { to, fingerprint: before.preview.fingerprint }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await pendingMove()).id, fingerprint: before.preview.fingerprint }));

    const after = await withOrg({ orgId: c.orgId }, (tx) => loadTasks(tx, { orgId: c.orgId }));
    const now2 = computeSchedule(toPlan(after), to, today());
    expect(now2.invalid).toBeNull();
    expect(Object.keys(now2.tasks!).sort()).toEqual(rows.map((t) => t.id).sort()); // every task still scheduled
    for (const t of rows) {
      expect(diffDays(now2.tasks![t.id]!.due, was[t.id]!.due), t.title).toBe(42);
      expect(diffDays(now2.tasks![t.id]!.startBy, was[t.id]!.startBy), t.title).toBe(42);
    }
    // No dependency points at a task that is not there.
    const ids = new Set(after.map((t) => t.id));
    for (const d of await db.taskDependency.findMany({ where: { orgId: c.orgId } })) expect(ids.has(d.taskId) && ids.has(d.dependsOnId)).toBe(true);

    const baseline = await db.scheduleBaseline.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'move' } });
    expect([dayOfDb(baseline.fromDate!), dayOfDb(baseline.toDate)]).toEqual([from, to]);
    const snap = baseline.snapshot as { tasks: Record<string, { dueFrom: string; dueTo: string }>; late: unknown[]; impossible: unknown[] };
    expect(Object.keys(snap.tasks).sort()).toEqual([...ids].sort()); // the baseline records every task, before and after
    for (const t of Object.values(snap.tasks)) expect(diffDays(t.dueTo, t.dueFrom)).toBe(42);
    expect(snap.late).toEqual([]);
    expect(snap.impossible).toEqual([]);
    expect(baseline.fingerprint).toBe(before.preview.fingerprint);
  });

  it('is atomic: a stale fingerprint at approval is refused and nothing at all changes', async () => {
    const p = await preview(to);
    await ok(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }));
    const r = await pendingMove();
    // The plan changes after the proposal: a task is finished, so the preview the proposer saw is no longer the plan.
    const task = await db.task.findFirstOrThrow({ where: { orgId: c.orgId, key: 'write-vows' } });
    await ok(setTaskStatus(c.slug, { id: task.id, status: 'done' }));
    await as(c.b);
    const before = await snapshot();
    await refused(approveRequest(c.slug, { id: r.id, fingerprint: p.preview.fingerprint }), /plan changed since this preview/);
    expect(await snapshot()).toBe(before); // date, baseline, flags, log and the request itself: all untouched
    expect((await db.consentRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
    // With the preview as it is now, the same request goes through.
    await ok(approveRequest(c.slug, { id: r.id, fingerprint: (await preview(to)).preview.fingerprint }));
    expect(dayOfDb((await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } })).date)).toBe(to);
  });

  it('approving without having seen a preview is refused', async () => {
    const p = await preview(to);
    await ok(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }));
    await as(c.b);
    await refused(approveRequest(c.slug, { id: (await pendingMove()).id, fingerprint: '' }), /Look at the preview/);
    expect(dayOfDb((await db.wedding.findUniqueOrThrow({ where: { orgId: c.orgId } })).date)).toBe(from);
  });

  it('proposing needs the current preview, a different date, and no other move waiting', async () => {
    await refused(proposeDateMove(c.slug, { to, fingerprint: 'not-the-preview' }), /plan changed since this preview/);
    await refused(proposeDateMove(c.slug, { to: from, fingerprint: 'x' }), /already on that date/);
    await refused(proposeDateMove(c.slug, { to: '2027-02-30', fingerprint: 'x' }), /Pick the new date/);
    const p = await preview(to);
    await ok(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }));
    await refused(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }), /already waiting/);
  });

  it('flags every booked vendor for re-confirmation, and no vendor that is only being considered', async () => {
    const mk = (name: string) => db.vendor.create({ data: { orgId: c.orgId, name, category: 'caterer' } });
    const [booked, considering] = [await mk('Fennel & Fig Catering'), await mk('Second Choice Catering')];
    await ok(proposeBooking(c.slug, { id: booked.id }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'book_vendor' } })).id }));
    await as(c.a);
    const p = await preview(to);
    await ok(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await pendingMove()).id, fingerprint: p.preview.fingerprint }));
    const flags = await db.vendorFlag.findMany({ where: { orgId: c.orgId } });
    expect(flags.map((f) => [f.vendorId, f.reason, f.detail, f.ackAt])).toEqual([[booked.id, 'date_moved', { from, to }, null]]);
    expect(flags.some((f) => f.vendorId === considering.id)).toBe(false);
  });

  it('logs the move with the old and new date', async () => {
    const p = await preview(to);
    await ok(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await pendingMove()).id, fingerprint: p.preview.fingerprint }));
    const moved = (await log(c.orgId)).find((e) => e.action === 'knotwork.wedding.moved')!;
    expect(moved.actorUserId).toBe(c.b); // the second key is who made it happen
    expect(moved.data).toMatchObject({ before: { date: from }, after: { date: to }, deltaDays: 42, late: 0, impossible: 0 });
  });
});

describe('a move that breaks things', () => {
  it('previews what becomes late and impossible, and commits exactly that (D-10)', async () => {
    const early = addDays(today(), 60);
    const p = await preview(early);
    expect(p.preview.late.length + p.preview.impossible.length).toBeGreaterThan(0);
    expect(p.preview.late.every((x) => x.isNew) && p.preview.impossible.every((x) => x.isNew)).toBe(true);
    await ok(proposeDateMove(c.slug, { to: early, fingerprint: p.preview.fingerprint }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await pendingMove()).id, fingerprint: p.preview.fingerprint }));
    const snap = (await db.scheduleBaseline.findFirstOrThrow({ where: { orgId: c.orgId, kind: 'move' } })).snapshot as { late: unknown[]; impossible: unknown[] };
    expect(snap.late).toEqual(p.preview.late);
    expect(snap.impossible).toEqual(p.preview.impossible);
  });

  it('the preview is as of today: a day later the same request needs a fresh look only if a state changed', async () => {
    const p = await preview(to);
    await ok(proposeDateMove(c.slug, { to, fingerprint: p.preview.fingerprint }));
    advanceClock(86_400_000);
    expect((await preview(to)).preview.fingerprint).toBe(p.preview.fingerprint); // nothing is near its dates, so nothing changed
  });
});

describe('editing the plan', () => {
  it('refuses a dependency circle by name and writes nothing', async () => {
    const a = await db.task.findFirstOrThrow({ where: { orgId: c.orgId, key: 'book-venue' } });
    const b = await db.task.findFirstOrThrow({ where: { orgId: c.orgId, key: 'book-caterer' } });
    const before = await snapshot();
    // book-caterer already depends on book-venue; making book-venue depend on book-caterer closes a circle.
    await refused(updateTask(c.slug, { id: a.id, title: a.title, leadDays: a.leadDays, bufferDays: a.bufferDays, assigneeId: '', dependsOn: [b.id] }), /circle: Book the venue, Book the caterer|circle: Book the caterer, Book the venue/);
    await refused(updateTask(c.slug, { id: a.id, title: a.title, leadDays: a.leadDays, bufferDays: a.bufferDays, assigneeId: '', dependsOn: [a.id] }), /circle: Book the venue/);
    expect(await snapshot()).toBe(before);
  });
});
