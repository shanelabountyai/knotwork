import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveRequest, createWedding, proposeDateMove, proposeSettings } from '@/app/o/[org]/wedding/actions';
import { proposeMode } from '@/app/o/[org]/wedding/life/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { previewDateMove } from '@/lib/knotwork/schedule/store';
import { resetAuthTables } from '../helpers/auth';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, goToDay, makeWedding, ok, type Couple } from './db';

// D-170 (review of PR #6, should-fix 2). The wedding's designated guards used to refuse a change only when it named
// the PREVIOUS request. An executed request stays 'approved', so a direct UPDATE could name an older one again: the
// mode A -> B, then A once more. Now the database keeps every request the date, the approval rules and the mode were
// changed with (Wedding.usedRequestIds, trigger Wedding_request_once) and refuses one of them a second time. Each
// guard is attacked here with raw SQL as the owner role, past all application code, after A and then B were used
// through the real actions; the legitimate paths (two keys, solo, reversal, a fresh proposal) still go through.
const MIGRATION = 'prisma/migrations/20261128000002_knotwork_guard_used_request/migration.sql';
const USED = /that request has already been used/;
const today = () => todayIn('America/Chicago', now());
const sql = (q: string) => db.$executeRawUnsafe(q);
let c: Couple;
let date: string;

const wedding = (orgId = c.orgId) => db.wedding.findUniqueOrThrow({ where: { orgId } });
const pending = (kind: string, orgId = c.orgId) => db.consentRequest.findFirstOrThrow({ where: { orgId, kind: kind as never, status: 'pending' }, orderBy: { proposedAt: 'desc' } });
const latestApproved = (kind: string, orgId = c.orgId) => db.consentRequest.findFirstOrThrow({ where: { orgId, kind: kind as never, status: 'approved' }, orderBy: [{ executedAt: 'desc' }, { proposedAt: 'desc' }] });
const fingerprintFor = async (to: string) => (await withOrg({ orgId: c.orgId }, async (tx) => previewDateMove(tx, { orgId: c.orgId }, await wedding(), to))).preview.fingerprint;

/** Juniper proposes, Rowan approves; returns the request that was executed. */
async function moveDate(to: string) {
  await as(c.a);
  await ok(proposeDateMove(c.slug, { to, fingerprint: await fingerprintFor(to) }));
  const r = await pending('change_date');
  await as(c.b);
  await ok(approveRequest(c.slug, { id: r.id, fingerprint: await fingerprintFor(to) }));
  return r.id;
}
async function changeRules(spendThreshold: string) {
  await as(c.a);
  await ok(proposeSettings(c.slug, { spendThreshold, consentExpiryDays: '7', chaseBufferDays: '14' }));
  const r = await pending('change_settings');
  await as(c.b);
  await ok(approveRequest(c.slug, { id: r.id, fingerprint: '' }));
  return r.id;
}
async function switchTo(to: 'life' | 'planning') {
  await as(c.a);
  await ok(proposeMode(c.slug, { to }));
  const r = await pending('set_mode');
  await as(c.b);
  await ok(approveRequest(c.slug, { id: r.id, fingerprint: '' }));
  return r.id;
}

describe('the date (Wedding_guard): a used change_date request never moves it again', () => {
  beforeEach(async () => {
    date = addDays(today(), 330);
    c = await makeWedding(date);
  });

  it('A then B through the actions; a direct UPDATE naming A again is refused, to any date', async () => {
    const a = await moveDate(addDays(date, 42));
    const b = await moveDate(addDays(date, 49));
    const w = await wedding();
    expect(dayOfDb(w.date)).toBe(addDays(date, 49));
    expect(w).toMatchObject({ dateRequestId: b, usedRequestIds: [a, b] });
    await expect(sql(`UPDATE "Wedding" SET date = '${addDays(date, 42)}', "dateRequestId" = '${a}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Wedding" SET date = '${addDays(date, 100)}', "dateRequestId" = '${a}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
    expect(dayOfDb((await wedding()).date)).toBe(addDays(date, 49));
  });

  it('clearing the request first does not make the last one new again', async () => {
    const a = await moveDate(addDays(date, 42));
    // The date is not touched, so the date guard lets the id go; the list keeps it.
    await expect(sql(`UPDATE "Wedding" SET "dateRequestId" = NULL WHERE "orgId" = '${c.orgId}'`)).resolves.toBe(1);
    await expect(sql(`UPDATE "Wedding" SET date = date + 7, "dateRequestId" = '${a}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
    expect(dayOfDb((await wedding()).date)).toBe(addDays(date, 42));
  });
});

describe('the approval rules (Wedding_guard): a used change_settings request never changes them again', () => {
  beforeEach(async () => {
    date = addDays(today(), 330);
    c = await makeWedding(date);
  });

  it('A then B through the actions; a direct UPDATE naming A again is refused', async () => {
    const a = await changeRules('600');
    const b = await changeRules('700');
    expect(await wedding()).toMatchObject({ spendThresholdCents: 70_000, settingsRequestId: b, usedRequestIds: [a, b] });
    await expect(sql(`UPDATE "Wedding" SET "spendThresholdCents" = 60000, "settingsRequestId" = '${a}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Wedding" SET "spendThresholdCents" = 99999999, "settingsRequestId" = '${a}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
    expect((await wedding()).spendThresholdCents).toBe(70_000);
  });
});

describe('the mode (Wedding_mode_guard): a used set_mode request never switches it again', () => {
  beforeEach(async () => {
    date = addDays(today(), 3);
    c = await makeWedding(date);
    goToDay(addDays(date, 1));
  });

  it('A (into life-admin) then B (back); a direct UPDATE naming A again is refused; a fresh request C still switches', async () => {
    const a = await switchTo('life');
    const b = await switchTo('planning');
    expect(await wedding()).toMatchObject({ mode: 'planning', modeRequestId: b, usedRequestIds: [a, b] });
    // A is approved, of the right kind, names 'life' and is not the previous request: only "used before" stops it.
    await expect(sql(`UPDATE "Wedding" SET mode = 'life', "modeRequestId" = '${a}', "modeChangedAt" = now() WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
    expect((await wedding()).mode).toBe('planning');
    // Reversal and re-proposal are new requests, so they go through.
    const fresh = await switchTo('life');
    expect(await wedding()).toMatchObject({ mode: 'life', modeRequestId: fresh, usedRequestIds: [a, b, fresh] });
    await expect(sql(`UPDATE "Wedding" SET mode = 'planning', "modeRequestId" = '${b}', "modeChangedAt" = now() WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
  });

  it('in solo mode (D-33) the only partner switches there and back and there again; reusing the first is refused', async () => {
    await resetAuthTables();
    const org = await makeOrg('solo-used-request');
    const a = (await addMember(org.id, 'owner', 'juniper@example.test')).id;
    goToDay(today());
    await as(a);
    await ok(createWedding(org.slug, { title: 'Juniper', date: addDays(today(), 3), timeZone: 'America/Chicago' }));
    goToDay(addDays(today(), 4));
    await as(a);
    const solo = async (to: 'life' | 'planning') => {
      await ok(proposeMode(org.slug, { to }));
      const r = await latestApproved('set_mode', org.id);
      expect(r).toMatchObject({ solo: true, payload: { to } });
      return r.id;
    };
    const first = await solo('life');
    const second = await solo('planning');
    const third = await solo('life');
    expect(await wedding(org.id)).toMatchObject({ mode: 'life', usedRequestIds: [first, second, third] });
    await expect(sql(`UPDATE "Wedding" SET mode = 'planning', "modeRequestId" = '${second}', "modeChangedAt" = now() WHERE "orgId" = '${org.id}'`)).rejects.toThrow(USED);
  });
});

describe('the list of used requests is the database\'s own', () => {
  beforeEach(async () => {
    date = addDays(today(), 330);
    c = await makeWedding(date);
  });

  it('no writer may set it, through Prisma or raw SQL', async () => {
    const a = await changeRules('600');
    await expect(sql(`UPDATE "Wedding" SET "usedRequestIds" = '{}' WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/kept by the database/);
    await expect(db.wedding.update({ where: { orgId: c.orgId }, data: { usedRequestIds: [] } })).rejects.toThrow(/kept by the database/);
    expect((await wedding()).usedRequestIds).toEqual([a]);
    // Other columns still change freely.
    await expect(sql(`UPDATE "Wedding" SET title = 'Renamed' WHERE "orgId" = '${c.orgId}'`)).resolves.toBe(1);
  });

  it('a wedding created again in the same workspace starts with its approved requests already used', async () => {
    const org = await makeOrg('reborn');
    const a = (await addMember(org.id, 'owner', 'a@example.test')).id;
    const b = (await addMember(org.id, 'owner', 'b@example.test')).id;
    const r = await db.consentRequest.create({ data: { orgId: org.id, kind: 'change_date', payload: { from: '2027-01-01', to: '2027-02-01' }, summary: 'raw', proposerId: a, expiresAt: new Date(now().getTime() + 86_400_000) } });
    await sql(`UPDATE "ConsentRequest" SET status = 'approved', "deciderId" = '${b}', "decidedAt" = now(), "executedAt" = now() WHERE id = '${r.id}'`);
    await expect(sql(`INSERT INTO "Wedding" (id, "orgId", title, date, "dateRequestId", "updatedAt") VALUES (gen_random_uuid(), '${org.id}', 'x', '2027-02-01', '${r.id}', now())`)).rejects.toThrow(USED);
    const w = await db.wedding.create({ data: { orgId: org.id, title: 'x', date: new Date('2027-02-01T00:00:00Z'), usedRequestIds: [] } });
    expect(w.usedRequestIds).toEqual([r.id]);
    await expect(sql(`UPDATE "Wedding" SET date = '2027-03-01', "dateRequestId" = '${r.id}' WHERE id = '${w.id}'`)).rejects.toThrow(USED);
  });
});

describe('the migration on existing data', () => {
  const backfill = () => {
    const text = readFileSync(MIGRATION, 'utf8');
    const start = text.indexOf('-- BACKFILL.');
    const end = text.indexOf('-- END BACKFILL');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return sql(text.slice(start, end));
  };
  afterEach(async () => {
    await sql('ALTER TABLE "Wedding" ENABLE TRIGGER "Wedding_request_once"');
  });

  it('marks every approved date, rules and mode request of the workspace as used, so none is new again', async () => {
    date = addDays(today(), 3);
    c = await makeWedding(date);
    const rules = await changeRules('600');
    goToDay(addDays(date, 1));
    const a = await switchTo('life');
    const b = await switchTo('planning');
    // The state before the migration: no list.
    await sql('ALTER TABLE "Wedding" DISABLE TRIGGER "Wedding_request_once"');
    await sql(`UPDATE "Wedding" SET "usedRequestIds" = NULL WHERE "orgId" = '${c.orgId}'`);
    await backfill();
    await sql('ALTER TABLE "Wedding" ENABLE TRIGGER "Wedding_request_once"');
    expect([...(await wedding()).usedRequestIds].sort()).toEqual([rules, a, b].sort());
    await expect(sql(`UPDATE "Wedding" SET mode = 'life', "modeRequestId" = '${a}', "modeChangedAt" = now() WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(USED);
    await expect(sql(`UPDATE "Wedding" SET "spendThresholdCents" = 1, "settingsRequestId" = NULL WHERE "orgId" = '${c.orgId}'`)).rejects.toThrow(/changing the approval rules/);
    // And the next legitimate switch still goes through.
    const fresh = await switchTo('life');
    expect((await wedding()).modeRequestId).toBe(fresh);
  });
});
