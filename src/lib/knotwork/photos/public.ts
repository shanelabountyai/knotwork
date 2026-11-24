// The guest's side of the photo wall (PRD P0-6: "tokenized upload, no account"). The token in /p/[token] is the
// credential: 32 random bytes, matched by its sha256 (INV-07). This is the ONE photo file allowed to read across orgs
// (asSystem, src/core/db/cross-org.ts), for two reasons: the token names the event before any org is known, and the
// retention purge (cron) has to find the workspaces that hold photos. Everything after either lookup runs inside one
// org's scope. What a guest is shown comes from projection.ts (rule 3): the wedding's title and the event's name.
//
// Unknown, malformed, closed and expired links all answer the same nothing (one 404).
import { asSystem, withOrg } from '@/core/db/rls';
import { hit } from '@/core/rate-limit';
import { hashToken, newToken } from '@/core/tokens';
import { requireWedding } from '../context';
import type { Processed } from '../uploads/process';
import { asLimit, LIMIT_ORDER, limitKeys, PHOTO_LIMITS } from './limits';
import { checkText, uploadView, type PhotoDone, type PhotoProblem, type UploadView } from './projection';
import { addPhoto, eventOpen, purgeExpired } from './store';

const TOKEN = /^[\w-]{20,100}$/;
export const DEVICE_COOKIE = 'kw_photo_device';
/** How long a device cookie lasts: longer than any event's uploads can stay open. */
export const DEVICE_COOKIE_DAYS = 400;

async function find(token: string): Promise<{ orgId: string; id: string } | null> {
  if (!TOKEN.test(token)) return null;
  // Cross-org (cross-org.ts): the token names the event; its org is not known until this read.
  return asSystem((sys) => sys.photoEvent.findUnique({ where: { uploadTokenHash: hashToken(token) }, select: { orgId: true, id: true } }));
}

/** The event behind a link, if the link is working right now (uploads open, and not past the last upload day). */
async function openEvent(token: string) {
  const found = await find(token);
  if (!found) return null;
  return withOrg({ orgId: found.orgId }, async (tx) => {
    const event = await tx.photoEvent.findFirst({ where: { id: found.id, orgId: found.orgId } });
    if (!event || !(await eventOpen(tx, found.orgId, event))) return null;
    return { orgId: found.orgId, event, wedding: await requireWedding(tx, { orgId: found.orgId }) };
  });
}

const pageLimit = (ip: string) => hit(`photo:page:${ip}`, asLimit(PHOTO_LIMITS.pagePerAddress));

/** What the upload page shows. Null for every link that is not working: one 404 for all of them. */
export async function readUploadPage(token: string, ip: string): Promise<UploadView | 'limited' | null> {
  if (!(await pageLimit(ip))) return 'limited';
  const open = await openEvent(token);
  return open ? uploadView({ wedding: { title: open.wedding.title }, event: { name: open.event.name } }) : null;
}

/** Leave to store one upload: which event, which device, and the cookie to set if the device is new. */
export type Ticket = { orgId: string; eventId: string; deviceHash: string; newDeviceToken: string | null };
export type Opened = { ok: true; ticket: Ticket } | { ok: false; code: Extract<PhotoProblem, 'refused' | 'busy'> } | 'limited' | null;

/**
 * Everything that is decided BEFORE the file is read: the link, the device (blocked devices are refused, and told
 * only that the photo could not be added), and the three limits in rules/photo-limits.json, in order. `deviceToken`
 * is the cookie's value, or null on a device's first upload (a new one is made).
 */
export async function openUpload(token: string, ip: string, deviceToken: string | null): Promise<Opened> {
  if (!(await pageLimit(ip))) return 'limited';
  const open = await openEvent(token);
  if (!open) return null;
  const known = deviceToken && TOKEN.test(deviceToken) ? deviceToken : null;
  const device = known ?? newToken();
  const deviceHash = hashToken(device);
  if (known) {
    const row = await withOrg({ orgId: open.orgId }, (tx) => tx.photoDevice.findFirst({ where: { orgId: open.orgId, eventId: open.event.id, tokenHash: deviceHash }, select: { blockedAt: true } }));
    if (row?.blockedAt) return { ok: false, code: 'refused' };
  }
  const keys = limitKeys(open.event.id, deviceHash, ip);
  const limits = { device: PHOTO_LIMITS.upload.perDevice, address: PHOTO_LIMITS.upload.perAddress, event: PHOTO_LIMITS.upload.perEvent };
  for (const name of LIMIT_ORDER) if (!(await hit(keys[name], asLimit(limits[name])))) return { ok: false, code: 'busy' };
  return { ok: true, ticket: { orgId: open.orgId, eventId: open.event.id, deviceHash, newDeviceToken: known ? null : device } };
}

export type Kept = { ok: true; done: PhotoDone } | { ok: false; code: PhotoProblem } | null;

/** Stores a processed image under a ticket. The name and caption are checked here: one plain line each (D-61). */
export async function keepUpload(ticket: Ticket, text: { name: string; caption: string }, image: Processed): Promise<Kept> {
  const checked = checkText(text);
  if (!checked.ok) return checked;
  const stored = await withOrg({ orgId: ticket.orgId }, (tx) => addPhoto(tx, ticket.orgId, ticket.eventId, ticket.deviceHash, { name: checked.name, caption: checked.caption }, image));
  if (!stored) return null;
  return stored.ok ? { ok: true, done: stored.status } : { ok: false, code: stored.code };
}

/** The cron job (src/app/cron-jobs.ts): the retention purge in every workspace that still holds photo bytes. */
export async function purgePhotosEverywhere(): Promise<{ orgs: number; purged: number }> {
  // Cross-org (cross-org.ts): a cron run has no org; it lists the ones with photos left to purge.
  const orgs = await asSystem((sys) => sys.photo.findMany({ where: { purgedAt: null }, distinct: ['orgId'], select: { orgId: true } }));
  let purged = 0;
  for (const { orgId } of orgs) purged += await withOrg({ orgId }, (tx) => purgeExpired(tx, { orgId, userId: null }));
  return { orgs: orgs.length, purged };
}
