// The vendor's side of its read-only link (D-42). The token in /v/[token] is the credential: 32 random bytes, matched
// by its sha256 (INV-07). This is the ONE vendor file allowed to read across orgs (asSystem, src/core/db/cross-org.ts):
// the token names the vendor before any org is known. Everything after that one lookup runs inside the vendor's own
// org scope, and everything shown comes from projection.ts (rule 3): the wedding's title, the vendor's name and its
// own role-filtered brief.
//
// Unknown, malformed, replaced, ended, expired, dropped and private all answer the same nothing (one 404).
import { asSystem, withOrg } from '@/core/db/rls';
import { hit } from '@/core/rate-limit';
import { hashToken } from '@/core/tokens';
import { requireWedding, todayOf, weddingDay } from '../context';
import { nobodyLens } from '../secrecy/seal';
import { linkWorks, vendorLinkView, type VendorLinkView } from './projection';
import { briefInput } from './store';

const TOKEN = /^[\w-]{20,100}$/;
/** Generous for a vendor checking the brief, tight for someone guessing tokens. Per IP. */
export const VENDOR_LINK_LIMIT = { limit: 60, windowMs: 15 * 60_000 };

/** What the vendor's page shows. Null for every link that is not working: one 404 for all of them. */
export async function readVendorLink(token: string, ip: string): Promise<VendorLinkView | 'limited' | null> {
  if (!(await hit(`vendor-link:ip:${ip}`, VENDOR_LINK_LIMIT))) return 'limited';
  if (!TOKEN.test(token)) return null;
  // Cross-org (cross-org.ts): the token names the vendor; its org is not known until this read.
  const found = await asSystem((sys) => sys.vendor.findUnique({ where: { linkTokenHash: hashToken(token) }, select: { orgId: true, id: true } }));
  if (!found) return null;
  return withOrg({ orgId: found.orgId }, async (tx) => {
    const v = await tx.vendor.findFirst({ where: { id: found.id, orgId: found.orgId }, select: { status: true, privateToId: true, revealDays: true } });
    if (!v || v.status === 'dropped') return null;
    const L = await nobodyLens(tx, found.orgId);
    if (!L || L.vendor(v).hidden) return null; // a private vendor has no link (D-128); this holds even if one were left
    const wedding = await requireWedding(tx, { orgId: found.orgId });
    if (!linkWorks(weddingDay(wedding), todayOf(wedding))) return null;
    return vendorLinkView(await briefInput(tx, { orgId: found.orgId }, found.id));
  });
}
