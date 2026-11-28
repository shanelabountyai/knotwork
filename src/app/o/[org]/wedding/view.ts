// What every Knotwork page loads first, in one org-scoped read: who is looking, the wedding, today, and the people.
import { notFound } from 'next/navigation';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { allows, type Capability, type Who } from '@/lib/knotwork/access';
import { loadWedding, loadWho, syncPairing, todayOf, weddingDay, type WeddingRow } from '@/lib/knotwork/context';
import type { Day } from '@/lib/knotwork/days';

export type View = { who: Who; wedding: WeddingRow; today: Day; date: Day; people: Map<string, string>; partners: string[] };

/**
 * Runs `fn` inside the org's scope with the page's basics. A page the viewer may not see is notFound, like a page
 * that does not exist; a workspace with no wedding yet sends every wedding page to the home page's create form.
 */
export async function view<T>(ctx: OrgCtx, cap: Capability, fn: (tx: Tx, v: View) => Promise<T>): Promise<(T & { v: View }) | null> {
  return withOrg(ctx, async (tx) => {
    const who = await loadWho(tx, ctx);
    if (!allows(who, cap)) notFound();
    const found = await loadWedding(tx, ctx);
    if (!found) return null;
    const { wedding } = await syncPairing(tx, ctx, found); // D-33: two partners seen once ends solo mode for good
    const members = await tx.membership.findMany({ where: inOrg(ctx), select: { userId: true, role: true, user: { select: { email: true, name: true } } }, orderBy: { createdAt: 'asc' } });
    const v: View = {
      who, wedding, today: todayOf(wedding), date: weddingDay(wedding),
      people: new Map(members.map((m) => [m.userId, m.user.name || m.user.email])),
      partners: members.filter((m) => m.role === 'owner').map((m) => m.userId),
    };
    return { ...(await fn(tx, v)), v };
  });
}

export const nameOf = (v: View, userId: string | null | undefined) => (userId ? (v.people.get(userId) ?? 'someone who has left') : 'the app');
/** The other partner's name, for the keys' words; "your partner" while there is none. */
export const partnerName = (v: View, me: string) => {
  const other = v.partners.find((id) => id !== me);
  return other ? nameOf(v, other) : 'your partner';
};
