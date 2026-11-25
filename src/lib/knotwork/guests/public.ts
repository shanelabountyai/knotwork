// The guest's side of an RSVP link (PRD P0-3: "RSVP via tokenized links"). The token is the credential: 32 random
// bytes, matched by its sha256 (INV-07); a sealed copy is also kept so reminders can reuse the link (D-46). This is the ONE Knotwork file allowed to read across orgs (asSystem,
// src/core/db/cross-org.ts): the token names the household before any org is known. Everything after that one lookup
// runs inside the household's own org scope, and everything returned to the guest comes from projection.ts (rule 3).
import { inOrg } from '@/core/authz/guards';
import { asSystem, withOrg, type Tx } from '@/core/db/rls';
import { hit } from '@/core/rate-limit';
import { Refused } from '@/core/errors';
import { log } from '@/core/log';
import { hashToken } from '@/core/tokens';
import { requireWedding, weddingDay } from '../context';
import { lockWedding } from '../schedule/store';
import { entitlement } from './plus-one';
import { checkGuestReply, RSVP_PROBLEM, rsvpView, stopView, type RsvpSubmission, type RsvpView, type StopView } from './projection';
import { applyRsvp, loadPlan, rsvpDeadline, sendDueReminders, stopReminders, toIn } from './store';

/** Generous for a family filling in a form, tight for someone guessing tokens. Per IP. */
export const RSVP_LIMIT = { limit: 60, windowMs: 15 * 60_000 };

async function find(token: string): Promise<{ orgId: string; id: string } | null> {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  // Cross-org (cross-org.ts): the token names the household; its org is not known until this read.
  return asSystem((sys) => sys.household.findFirst({ where: { rsvpTokenHash: hashToken(token), state: 'invited' }, select: { orgId: true, id: true } }));
}

/**
 * The household an RSVP link names, for the other page on the same link (/r/[token]/gifts, D-63). The same rate limit
 * and the same answers as the RSVP page: 'limited', or null for an unknown, malformed or not-yet-invited token.
 * Exported so gifts/public.ts does not need a second cross-org lookup (INV-32: this stays the one file).
 */
export async function householdOfLink(token: string, ip: string): Promise<{ orgId: string; id: string } | 'limited' | null> {
  if (!(await hit(`rsvp:ip:${ip}`, RSVP_LIMIT))) return 'limited';
  return find(token);
}

async function viewOf(tx: Tx, orgId: string, householdId: string): Promise<RsvpView | null> {
  const ctx = { orgId };
  const h = await tx.household.findFirst({ where: { id: householdId, ...inOrg(ctx), state: 'invited' }, include: { guests: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
  if (!h) return null;
  const wedding = await requireWedding(tx, ctx);
  const core = toIn(h);
  return rsvpView({
    wedding: { title: wedding.title, date: weddingDay(wedding) },
    rsvpBy: await rsvpDeadline(tx, ctx, wedding),
    mealOptions: (await loadPlan(tx, ctx)).mealOptions,
    household: { name: h.name, plusOneAllowed: entitlement(core).entitled },
    guests: h.guests.filter((g) => !g.removedAt).map((g) => ({ id: g.id, name: g.name, ageGroup: g.ageGroup, isPlusOne: g.isPlusOne, rsvp: g.rsvp, meal: g.meal, dietary: g.dietary, accessibility: g.accessibility, songRequest: g.songRequest })),
  });
}

/** What the RSVP page shows. Unknown, not-yet-invited and malformed tokens all return null: one 404 for all of them. */
export async function readRsvp(token: string, ip: string): Promise<RsvpView | 'limited' | null> {
  if (!(await hit(`rsvp:ip:${ip}`, RSVP_LIMIT))) return 'limited';
  const h = await find(token);
  return h ? withOrg({ orgId: h.orgId }, (tx) => viewOf(tx, h.orgId, h.id)) : null;
}

/** A guest's reply. Checked against exactly what that guest was shown; nothing outside their household can be touched. */
export async function submitRsvp(token: string, ip: string, submission: RsvpSubmission): Promise<{ ok: true } | { ok: false; message: string } | 'limited' | null> {
  if (!(await hit(`rsvp:ip:${ip}`, RSVP_LIMIT))) return 'limited';
  const h = await find(token);
  if (!h) return null;
  const saved = withOrg({ orgId: h.orgId }, async (tx) => {
    // The wedding lock comes BEFORE the view is read: the reply is checked against what is true once every earlier
    // reply has committed. Checked first and locked after, several replies sent at once each saw "no guest named yet"
    // and each added one (review 2026-11-24, M2).
    await lockWedding(tx, h.orgId);
    const view = await viewOf(tx, h.orgId, h.id);
    if (!view) return null;
    const checked = checkGuestReply(view, submission);
    if (!checked.ok) return checked;
    await applyRsvp(tx, { orgId: h.orgId, userId: null }, h.id, checked);
    return { ok: true as const };
  });
  // A refusal from the store (no seat left for this reply) rolled the transaction back. The guest gets one neutral
  // sentence: never the cap, never a count, and the same words whatever list they are on (rule 3). Before the review
  // of 2026-11-24 (M1) this escaped as an unhandled error, a 500 on the guest's own invitation.
  return saved.catch((e: unknown) => {
    if (e instanceof Refused) return { ok: false as const, message: RSVP_PROBLEM.full };
    throw e;
  });
}

// ---- the opt-out (Phase 5): /r/[token]/stop, on the same token, the same rate limit and the same 404s

/** What the opt-out page shows: the wedding's title and nothing about the household (stopView). */
export async function readStop(token: string, ip: string): Promise<StopView | 'limited' | null> {
  if (!(await hit(`rsvp:ip:${ip}`, RSVP_LIMIT))) return 'limited';
  const h = await find(token);
  return h ? withOrg({ orgId: h.orgId }, async (tx) => stopView({ wedding: { title: (await requireWedding(tx, { orgId: h.orgId })).title } })) : null;
}

/** The household stops its reminders: at once, and a second time changes nothing (the answer is the same). */
export async function stopFromLink(token: string, ip: string): Promise<'stopped' | 'limited' | null> {
  if (!(await hit(`rsvp:ip:${ip}`, RSVP_LIMIT))) return 'limited';
  const h = await find(token);
  if (!h) return null;
  await withOrg({ orgId: h.orgId }, (tx) => stopReminders(tx, h.orgId, h.id));
  return 'stopped';
}

/**
 * The cron job (src/app/cron-jobs.ts): due reminders in every workspace that turned the daily schedule on
 * (GuestPlan.autoReminders). The same `sendDueReminders` as the button, so the cadence and its idempotence are one.
 * A workspace that cannot send (its saved links can no longer be read) is counted and skipped; the others go on.
 */
export async function sendRemindersEverywhere(): Promise<{ orgs: number; reminded: number; skipped: number }> {
  // Cross-org (cross-org.ts): a cron run has no org; it lists the ones that asked for scheduled reminders.
  const plans = await asSystem((sys) => sys.guestPlan.findMany({ where: { autoReminders: true }, select: { orgId: true }, orderBy: { orgId: 'asc' } }));
  let reminded = 0;
  let skipped = 0;
  for (const { orgId } of plans) {
    try {
      reminded += await withOrg({ orgId }, async (tx) => ((await tx.wedding.findUnique({ where: { orgId }, select: { id: true } })) ? sendDueReminders(tx, { orgId, userId: null }) : 0));
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      skipped++;
      log('knotwork.reminders.skipped', { orgId });
    }
  }
  return { orgs: plans.length, reminded, skipped };
}
