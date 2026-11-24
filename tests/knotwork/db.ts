// Shared by the Knotwork database tests: a synthetic couple (two owners), a helper, and a wedding from the template.
import { expect } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { createWedding } from '@/app/o/[org]/wedding/actions';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { addMember, makeOrg } from '../helpers/org';

export { db };
export type Couple = { slug: string; orgId: string; a: string; b: string; helper: string };

/** What an action did: its return value ({ error } when refused), or where it sent the browser. */
export async function outcome(p: Promise<unknown>): Promise<{ result?: unknown; error?: string; nav?: string; to?: string }> {
  try {
    const result = await p;
    return result && typeof result === 'object' && 'error' in result ? { error: String((result as { error: unknown }).error) } : { result };
  } catch (e) {
    if (e instanceof NavSignal) return { nav: e.kind, to: e.to };
    throw e;
  }
}
/** The action went through (it redirected). */
export async function ok(p: Promise<unknown>) {
  const o = await outcome(p);
  expect(o, JSON.stringify(o)).toMatchObject({ nav: 'redirect' });
  expect(o.to, 'the session had expired: sign in again after advancing the clock').not.toMatch(/^\/login/);
  return o.to!;
}
/** The action was refused with a message matching `re`. */
export async function refused(p: Promise<unknown>, re: RegExp) {
  const o = await outcome(p);
  expect(o.error ?? JSON.stringify(o)).toMatch(re);
}

export const as = (userId: string) => signInAs(userId, { mfa: true });

/** Two owners (Juniper, Rowan) and a helper (Maple, a plain member) in one fresh org. No wedding yet. */
export async function makeCouple(slug = 'juniper-rowan'): Promise<Couple> {
  await resetAuthTables();
  const org = await makeOrg(slug);
  const a = (await addMember(org.id, 'owner', 'juniper@example.test')).id;
  const b = (await addMember(org.id, 'owner', 'rowan@example.test')).id;
  const helper = (await addMember(org.id, 'member', 'maple@example.test')).id;
  return { slug: org.slug, orgId: org.id, a, b, helper };
}

/** The couple plus a wedding on `date`, created by Juniper through the real action (template tasks and first baseline). */
export async function makeWedding(date: string, slug?: string): Promise<Couple> {
  const c = await makeCouple(slug);
  await as(c.a);
  await ok(createWedding(c.slug, { title: 'Juniper & Rowan', date, timeZone: 'America/Chicago' }));
  return c;
}

/** Every table's rows as one string, so "nothing changed" is one comparison. Signing in writes Session and User.lastSignInAt; no Knotwork code writes either. */
export async function snapshot(): Promise<string> {
  const tables = (await db.$queryRaw<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema() AND tablename NOT IN ('_prisma_migrations', 'RateLimit', 'Session', 'User') ORDER BY 1`).map((r) => r.t);
  const rows = await Promise.all(tables.map((t) => db.$queryRawUnsafe<{ j: string }[]>(`SELECT coalesce(json_agg(x ORDER BY x::text)::text, '[]') AS j FROM "${t}" x`)));
  return rows.map((r, i) => `${tables[i]}:${r[0]!.j}`).join('\n');
}

export const log = (orgId: string) => db.auditEvent.findMany({ where: { orgId, action: { startsWith: 'knotwork.' } }, orderBy: { id: 'asc' } });
