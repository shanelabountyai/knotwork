import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addCategory } from '@/app/o/[org]/wedding/actions';
import { now } from '@/core/clock';
import { addDays, dayOfDb, todayIn } from '@/lib/knotwork/days';
import { as, db, makeWedding, ok, type Couple } from './db';

// D-199: a temporary table must not answer a guard's question. No Knotwork guard function set `search_path`, and each
// names its tables unqualified ("ConsentRequest", "Membership", "Wedding", "Org"). Postgres looks in the session's
// temporary schema first for tables, and every role may create temporary tables, so the app's own login could
// CREATE TEMP TABLE "ConsentRequest", put an "approved" row in it, and every guard read that row instead of the real
// one. Migration 20261128000020_knotwork_guard_search_path pins `search_path = pg_catalog, public, pg_temp` on every
// function in `public`; with it reverted, each attack below goes through (the PR body has the run).
//
// The attacker here is what the app's login is in enforce mode: a role that owns nothing, NOBYPASSRLS, holding the
// grants scripts/db-setup.ts gives the app role, and nothing else. It cannot disable a trigger. Each attack is one
// transaction (a temporary table lives in one session), and the statement it must not get away with is refused by the
// same role when there is no temporary table: the two halves of every test below.
const ROLE = 'knotwork_search_path_probe';
const PIN = 'search_path=pg_catalog, public, pg_temp';
const today = () => todayIn('America/Chicago', now());
let c: Couple;
let date: string;

type Run = (q: string) => Promise<unknown>;
/**
 * Runs `steps` as the app-shaped role, in one transaction with the workspace set as `withOrg` sets it, on a connection
 * of its own. A new connection matters: a session that has already run a guard may keep its plan, which names the
 * real table, so on a pooled connection the attack works or not by luck. An attacker opens a session and goes first.
 */
async function asAppLogin(steps: (run: Run) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_SYSTEM || process.env.DATABASE_URL });
  await client.connect();
  const run: Run = (q) => client.query(q);
  try {
    await run('BEGIN');
    await run(`SELECT set_config('app.org_id', '${c.orgId}', true)`);
    await run(`SET LOCAL ROLE "${ROLE}"`);
    await steps(run);
    await run('COMMIT');
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}
const wedding = () => db.wedding.findUnique({ where: { orgId: c.orgId } });
const pendingRequest = (kind: string, payload: object) =>
  db.consentRequest.create({ data: { orgId: c.orgId, kind: kind as never, payload, summary: 'proposed by Juniper alone', proposerId: c.a, expiresAt: new Date(now().getTime() + 86_400_000) } });

beforeAll(async () => {
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE "${ROLE}" NOLOGIN NOBYPASSRLS NOSUPERUSER; END IF; END $$`);
  await db.$executeRawUnsafe(`GRANT "${ROLE}" TO CURRENT_USER`);
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${ROLE}"`);
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ROLE}"`);
});
afterAll(async () => {
  await db.$executeRawUnsafe(`DROP OWNED BY "${ROLE}"`);
  await db.$executeRawUnsafe(`DROP ROLE "${ROLE}"`);
});
beforeEach(async () => {
  date = addDays(today(), 330);
  c = await makeWedding(date);
});

describe('structure: every function in public pins its search_path, with pg_temp last', () => {
  it('no trigger or guard function, Knotwork\'s or the template\'s, is left unpinned (a new one must be created with the same SET)', async () => {
    // Every function in the app's schema that no extension owns. Not a list kept by hand: a function added by a
    // later migration is in pg_proc, so it is here. CREATE OR REPLACE without the SET clause drops the pin, and fails here too.
    const fns = await db.$queryRaw<{ fn: string; config: string[] | null; definer: boolean; triggers: number }[]>`
      SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config, p.prosecdef AS definer,
             (SELECT count(*)::int FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS triggers
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema()
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`;
    const knotwork = fns.filter((f) => f.fn.startsWith('knotwork_'));
    // The floor: what the migration found on the day it was written. More is fine; fewer means this query went blind.
    expect(knotwork.length).toBeGreaterThanOrEqual(34);
    expect(fns.map((f) => f.fn)).toEqual(expect.arrayContaining(['knotwork_require_approved(uuid,uuid,"ConsentKind",text)', 'knotwork_wedding_guard()', 'knotwork_request_partner_guard()', 'org_event_assign_seq()']));
    const unpinned = fns.filter((f) => (f.config ?? []).filter((s) => s.startsWith('search_path=')).join() !== PIN).map((f) => `${f.fn}: ${JSON.stringify(f.config)}`);
    expect(unpinned, 'create the function with: SET search_path = pg_catalog, public, pg_temp').toEqual([]);
    // SECURITY DEFINER runs as the owner, so an unpinned one is the worst kind: none may be missed.
    expect(fns.filter((f) => f.definer).map((f) => f.fn)).toEqual(['org_event_assign_seq()']);
    // And nothing fires a function this query cannot see (a trigger function in another schema).
    const elsewhere = await db.$queryRaw<{ fn: string }[]>`
      SELECT DISTINCT t.tgfoid::regprocedure::text AS fn FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE NOT t.tgisinternal AND n.nspname <> current_schema()`;
    expect(elsewhere).toEqual([]);
  });
});

describe('a temporary "ConsentRequest" does not approve anything (knotwork_require_approved, the Wedding guards)', () => {
  const stolen = () => addDays(date, 45);
  /** Juniper's own pending request, copied into a temporary table and marked approved there, for a date nobody proposed. */
  const shadow = async (run: Run, id: string) => {
    await run(`CREATE TEMP TABLE "ConsentRequest" ON COMMIT DROP AS SELECT * FROM public."ConsentRequest" WHERE "id" = '${id}'`);
    await run(`UPDATE pg_temp."ConsentRequest" SET "status" = 'approved', "payload" = '{"to":"${stolen()}"}'`);
  };
  const move = (run: Run, id: string) => run(`UPDATE public."Wedding" SET "date" = '${stolen()}', "dateRequestId" = '${id}' WHERE "orgId" = '${c.orgId}'`);

  it('the date does not move on a request only one partner has seen', async () => {
    const r = await pendingRequest('change_date', { to: addDays(date, 7) });
    // Without the temporary table the same role is refused: the request is pending.
    await expect(asAppLogin((run) => move(run, r.id))).rejects.toThrow(/changing the date needs an approved change_date request/);
    // With it, the guard must still read the real table.
    await expect(asAppLogin(async (run) => { await shadow(run, r.id); await move(run, r.id); })).rejects.toThrow(/changing the date needs an approved change_date request/);
    expect(dayOfDb((await wedding())!.date)).toBe(date);
    expect(await db.consentRequest.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'pending', deciderId: null });
  });

  it('nor when the caller names the temporary schema first itself', async () => {
    const r = await pendingRequest('change_date', { to: addDays(date, 7) });
    await expect(asAppLogin(async (run) => { await shadow(run, r.id); await run(`SET LOCAL search_path = pg_temp, public`); await move(run, r.id); })).rejects.toThrow(/changing the date needs an approved change_date request/);
    expect(dayOfDb((await wedding())!.date)).toBe(date);
  });

  it('the approval rules do not change either', async () => {
    const r = await pendingRequest('change_settings', { spendThresholdCents: 100_000, consentExpiryDays: 7, chaseBufferDays: 3 });
    const loosen = (run: Run) => run(`UPDATE public."Wedding" SET "spendThresholdCents" = 2000000000, "settingsRequestId" = '${r.id}' WHERE "orgId" = '${c.orgId}'`);
    const before = await wedding();
    await expect(asAppLogin(loosen)).rejects.toThrow(/changing the approval rules needs an approved change_settings request/);
    await expect(asAppLogin(async (run) => {
      await run(`CREATE TEMP TABLE "ConsentRequest" ON COMMIT DROP AS SELECT * FROM public."ConsentRequest" WHERE "id" = '${r.id}'`);
      await run(`UPDATE pg_temp."ConsentRequest" SET "status" = 'approved', "payload" = jsonb_build_object('spendThresholdCents', 2000000000, 'consentExpiryDays', ${before!.consentExpiryDays}, 'chaseBufferDays', ${before!.chaseBufferDays})`);
      await loosen(run);
    })).rejects.toThrow(/changing the approval rules needs an approved change_settings request/);
    expect((await wedding())!.spendThresholdCents).toBe(before!.spendThresholdCents);
  });
});

describe('a temporary "Org", "Wedding" or "Membership" changes no guard\'s answer', () => {
  it('"Org" (Wedding_delete_guard): the wedding is not deleted on its own', async () => {
    const drop = (run: Run) => run(`DELETE FROM public."Wedding" WHERE "orgId" = '${c.orgId}'`);
    await expect(asAppLogin(drop)).rejects.toThrow(/a wedding is never deleted on its own/);
    await expect(asAppLogin(async (run) => { await run(`CREATE TEMP TABLE "Org" ("id" uuid) ON COMMIT DROP`); await drop(run); })).rejects.toThrow(/a wedding is never deleted on its own/);
    expect(await wedding()).not.toBeNull();
  });

  it('"Wedding" (Expense_guard): a spend over the threshold still needs its request', async () => {
    await as(c.a);
    await ok(addCategory(c.slug, { name: 'Catering', estimate: '12,000' }));
    const categoryId = (await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
    const amount = (await wedding())!.spendThresholdCents + 1_000_000;
    const spend = (run: Run) => run(`INSERT INTO public."Expense" ("id", "orgId", "categoryId", "description", "amountCents", "paidOn") VALUES (gen_random_uuid(), '${c.orgId}', '${categoryId}', 'no second key', ${amount}, CURRENT_DATE)`);
    await expect(asAppLogin(spend)).rejects.toThrow(/a spend over the threshold needs an approved spend request/);
    await expect(asAppLogin(async (run) => {
      await run(`CREATE TEMP TABLE "Wedding" ON COMMIT DROP AS SELECT * FROM public."Wedding" WHERE "orgId" = '${c.orgId}'`);
      await run(`UPDATE pg_temp."Wedding" SET "spendThresholdCents" = 2147483647`);
      await spend(run);
    })).rejects.toThrow(/a spend over the threshold needs an approved spend request/);
    expect(await db.expense.count({ where: { orgId: c.orgId } })).toBe(0);
  });

  it('"Membership" (ConsentRequest_partner_guard): a helper is not made a partner for one statement', async () => {
    const r = await pendingRequest('change_date', { to: addDays(date, 7) });
    const approve = (run: Run) => run(`UPDATE public."ConsentRequest" SET "status" = 'approved', "deciderId" = '${c.helper}', "decidedAt" = now(), "executedAt" = now() WHERE "id" = '${r.id}'`);
    await expect(asAppLogin(approve)).rejects.toThrow(/only a partner of this workspace can approve a request/);
    await expect(asAppLogin(async (run) => {
      await run(`CREATE TEMP TABLE "Membership" ON COMMIT DROP AS SELECT * FROM public."Membership" WHERE "orgId" = '${c.orgId}'`);
      await run(`UPDATE pg_temp."Membership" SET "role" = 'owner'`);
      await approve(run);
    })).rejects.toThrow(/only a partner of this workspace can approve a request/);
    expect((await db.consentRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('pending');
  });
});
