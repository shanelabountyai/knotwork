// D-42, the vendor's read-only link: made, shown again, replaced and ended by the couple. A store; every write logs.
//
// The link is 32 random bytes in /v/[token]. Stored two ways: its sha256, which a request is matched against, and a
// sealed copy (AES-GCM under AUTH_SECRET, as for RSVP and photo links) so the couple can show it again. Replacing it
// stops the old one at once; ending it stops it without a new one. It works until a set number of days after the
// wedding (projection.ts, derived from the wedding date, rule 1). A private vendor has no link (D-128): making one is
// refused while it is private to anyone, making a vendor private ends its link (secrecy/store.ts), and the public read
// answers 404 for a sealed vendor anyway. A dropped vendor's link answers 404 too.
import { openSecret, sealSecret } from '@/core/auth/secret-box';
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { hashToken, newToken } from '@/core/tokens';
import { logChange } from '../changelog';
import { requireWedding, todayOf, weddingDay } from '../context';
import type { Day } from '../days';
import { nobodyLens } from '../secrecy/seal';
import { linkLastDay, linkWorks, VENDOR_LINK_DAYS_AFTER } from './projection';

type Ctx = { orgId: string; userId: string | null };
export const VENDOR_LINK_SEAL = 'knotwork-vendor-link';
const urlOf = (token: string) => `${env.APP_URL}/v/${token}`;

export type LinkState = { url: string | null; exists: boolean; lastDay: Day; working: boolean };

/** The vendor's link as the couple sees it: the URL (null when there is none, or its sealed copy cannot be opened). */
export async function vendorLinkOf(tx: Tx, ctx: { orgId: string }, id: string): Promise<LinkState> {
  const wedding = await requireWedding(tx, ctx);
  const v = await tx.vendor.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, select: { linkTokenSealed: true, status: true } });
  const token = v.linkTokenSealed ? openSecret(v.linkTokenSealed, VENDOR_LINK_SEAL) : null;
  const lastDay = linkLastDay(weddingDay(wedding));
  return { url: token ? urlOf(token) : null, exists: !!v.linkTokenSealed, lastDay, working: !!v.linkTokenSealed && v.status !== 'dropped' && linkWorks(weddingDay(wedding), todayOf(wedding)) };
}

/** Makes the vendor's link, or replaces it (the old one stops at once). Returns the new URL. */
export async function makeVendorLink(tx: Tx, ctx: Ctx, id: string): Promise<string> {
  const wedding = await requireWedding(tx, ctx);
  const v = await tx.vendor.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, select: { name: true, status: true, privateToId: true, revealDays: true, linkTokenHash: true } });
  const L = await nobodyLens(tx, ctx.orgId);
  if (L?.vendor(v).hidden) throw new Refused('A private vendor has no read-only link. Share the vendor first.');
  if (v.status === 'dropped') throw new Refused('A dropped vendor has no read-only link.');
  if (!linkWorks(weddingDay(wedding), todayOf(wedding))) throw new Refused(`Vendor links stop working ${VENDOR_LINK_DAYS_AFTER} days after the wedding, so a new one would not work.`);
  const token = newToken();
  await tx.vendor.update({ where: { id }, data: { linkTokenHash: hashToken(token), linkTokenSealed: sealSecret(token, VENDOR_LINK_SEAL) } });
  await logChange(tx, ctx, 'vendor', v.linkTokenHash ? 'relinked' : 'linked', id, v.name, null, { readOnlyLink: v.linkTokenHash ? 'replaced; the earlier link no longer works' : 'made' });
  return urlOf(token);
}

/** Ends the vendor's link: it is a 404 from this moment, and there is no new one. */
export async function endVendorLink(tx: Tx, ctx: Ctx, id: string) {
  const v = await tx.vendor.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, select: { name: true, linkTokenHash: true } });
  if (!v.linkTokenHash) throw new Refused('This vendor has no read-only link.');
  await tx.vendor.update({ where: { id }, data: { linkTokenHash: null, linkTokenSealed: null } });
  await logChange(tx, ctx, 'vendor', 'unlinked', id, v.name, null, { readOnlyLink: 'ended; it no longer works' });
}
