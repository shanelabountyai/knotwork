// The photo wall in the database (PRD P0-6): events and their upload links, photos, moderation, devices, the album,
// the wall feed, the gallery download and the retention purge. Every write logs its change in the same transaction.
//
// RULE 1: when a link stops and when photos are purged are derived from the wedding date on every read (dates.ts).
// RULE 4: a photo's bytes arrive here only as a `Processed` image (uploads/process.ts) and are written by blobs.ts.
import { openSecret, sealSecret } from '@/core/auth/secret-box';
import { inOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { hashToken, newToken } from '@/core/tokens';
import { logChange } from '../changelog';
import { requireWedding, todayOf, weddingDay } from '../context';
import type { Day } from '../days';
import type { Processed } from '../uploads/process';
import { deleteBlobs, readBlob, writeBlobs } from './blobs';
import { EVENT_BOUNDS, lastKeptDay, lastUploadDay, linkOpen, purgeDue } from './dates';
import { PHOTO_LIMITS } from './limits';
import { inAlbum, initialStatus, moderate, MODERATION_PROBLEM, onWall, type Action, type Mode } from './moderation';
import { zipStored, type ZipTime } from './zip';

type Ctx = { orgId: string; userId: string | null };
const SEAL = 'knotwork-photo-link';
const linkOf = (token: string) => `${env.APP_URL}/p/${token}`;

export type EventInput = { name: string; mode: Mode; uploadDays: number; retentionDays: number };

function checkDays(i: EventInput) {
  const { uploadDays: u, retentionDays: r } = EVENT_BOUNDS;
  if (!Number.isInteger(i.uploadDays) || i.uploadDays < u.min || i.uploadDays > u.max) throw new Refused(`Uploads can stay open from ${u.min} to ${u.max} days after the wedding.`);
  if (!Number.isInteger(i.retentionDays) || i.retentionDays < r.min || i.retentionDays > r.max) throw new Refused(`Photos can be kept from ${r.min} to ${r.max} days after the wedding.`);
  if (i.retentionDays < i.uploadDays) throw new Refused('Photos must be kept at least as long as uploads stay open.');
}

/** A new event with its upload link: 32 random bytes, kept as a sha256 and as a sealed copy for the QR code. */
export async function createEvent(tx: Tx, ctx: Ctx, input: EventInput) {
  await requireWedding(tx, ctx);
  checkDays(input);
  if (await tx.photoEvent.findFirst({ where: { ...inOrg(ctx), name: input.name }, select: { id: true } })) throw new Refused(`There is already a photo event called ${input.name}.`);
  const token = newToken();
  const event = await tx.photoEvent.create({ data: { orgId: ctx.orgId, ...input, uploadTokenHash: hashToken(token), uploadTokenSealed: sealSecret(token, SEAL), createdById: ctx.userId } });
  await logChange(tx, ctx, 'photoevent', 'created', event.id, event.name, null, { ...input, uploadsOpen: true });
  return event;
}

export async function updateEvent(tx: Tx, ctx: Ctx, id: string, input: EventInput) {
  const e = await tx.photoEvent.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  checkDays(input);
  if (input.name !== e.name && (await tx.photoEvent.findFirst({ where: { ...inOrg(ctx), name: input.name }, select: { id: true } }))) throw new Refused(`There is already a photo event called ${input.name}.`);
  await tx.photoEvent.update({ where: { id }, data: input });
  await logChange(tx, ctx, 'photoevent', 'updated', id, input.name, { name: e.name, mode: e.mode, uploadDays: e.uploadDays, retentionDays: e.retentionDays }, { ...input });
}

/** The couple's own switch: closed, the link is a 404 at once, whatever the date. */
export async function setUploadsOpen(tx: Tx, ctx: Ctx, id: string, open: boolean) {
  const e = await tx.photoEvent.findFirstOrThrow({ where: { id, ...inOrg(ctx) } });
  if (e.uploadsOpen === open) throw new Refused(open ? 'Uploads are already open.' : 'Uploads are already closed.');
  await tx.photoEvent.update({ where: { id }, data: { uploadsOpen: open } });
  await logChange(tx, ctx, 'photoevent', open ? 'opened' : 'closed', id, e.name, { uploadsOpen: e.uploadsOpen }, { uploadsOpen: open });
}

/** The event's upload link, from its sealed copy. Null when the copy can no longer be opened (AUTH_SECRET was rotated): the printed link still works; replace it to see one. */
export async function uploadLink(tx: Tx, ctx: { orgId: string }, id: string): Promise<string | null> {
  const e = await tx.photoEvent.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, select: { uploadTokenSealed: true } });
  const token = openSecret(e.uploadTokenSealed, SEAL);
  return token ? linkOf(token) : null;
}

/** Revokes the link and makes a new one: the printed QR code is a 404 from this moment. Logged, without the token. */
export async function replaceLink(tx: Tx, ctx: Ctx, id: string): Promise<string> {
  const e = await tx.photoEvent.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, select: { name: true } });
  const token = newToken();
  await tx.photoEvent.update({ where: { id }, data: { uploadTokenHash: hashToken(token), uploadTokenSealed: sealSecret(token, SEAL) } });
  await logChange(tx, ctx, 'photoevent', 'relinked', id, e.name, null, { uploadLink: 'replaced; the earlier link and its QR code no longer work' });
  return linkOf(token);
}

/** Is the event's link working right now? The wedding's date and today are read here, never stored. */
export async function eventOpen(tx: Tx, orgId: string, event: { uploadsOpen: boolean; uploadDays: number }): Promise<boolean> {
  const wedding = await requireWedding(tx, { orgId });
  return linkOpen(event, weddingDay(wedding), todayOf(wedding));
}

const labelOf = (p: { uploaderName: string }, eventName: string) => `Photo from ${p.uploaderName || 'a guest'} at ${eventName}`;

export type Stored = { ok: true; id: string; status: 'pending' | 'live' } | { ok: false; code: 'full' };

/**
 * Stores one processed photo for a device (made here on its first upload). Null when the event is gone or its link no
 * longer works. The status it starts in is the event's mode's (post: live; pre: pending).
 */
export async function addPhoto(tx: Tx, orgId: string, eventId: string, deviceHash: string, text: { name: string; caption: string }, image: Processed): Promise<Stored | null> {
  const event = await tx.photoEvent.findFirst({ where: { id: eventId, orgId } });
  if (!event || !(await eventOpen(tx, orgId, event))) return null;
  if ((await tx.photo.count({ where: { orgId, eventId, purgedAt: null } })) >= PHOTO_LIMITS.maxPhotosPerEvent) return { ok: false, code: 'full' };
  const at = now();
  const device = await tx.photoDevice.upsert({ where: { eventId_tokenHash: { eventId, tokenHash: deviceHash } }, create: { orgId, eventId, tokenHash: deviceHash, createdAt: at }, update: {} });
  if (device.blockedAt) return null;
  const status = initialStatus(event.mode) as 'pending' | 'live';
  const photo = await tx.photo.create({ data: { orgId, eventId, deviceId: device.id, uploaderName: text.name, caption: text.caption, status, mime: image.mime, width: image.width, height: image.height, createdAt: at } });
  await writeBlobs(tx, orgId, photo.id, image);
  await logChange(tx, { orgId, userId: null }, 'photo', 'uploaded', photo.id, labelOf(photo, event.name), null, { event: event.name, by: text.name, caption: text.caption, status, width: image.width, height: image.height }, { via: 'photo-link' });
  return { ok: true, id: photo.id, status };
}

const VERB: Record<Action, string> = { approve: 'approved', reject: 'rejected', take_down: 'removed', undo: 'restored' };

/** One moderation move, by the pure machine. A refused move writes nothing. */
export async function moderatePhoto(tx: Tx, ctx: Ctx, id: string, action: Action) {
  const p = await tx.photo.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { event: { select: { name: true, mode: true } } } });
  const moved = moderate({ status: p.status, removedFrom: p.removedFrom as 'pending' | 'live' | null }, action, p.event.mode, p.purgedAt !== null);
  if (!moved.ok) throw new Refused(MODERATION_PROBLEM[moved.code]);
  await tx.photo.update({ where: { id }, data: moved.next });
  await logChange(tx, ctx, 'photo', VERB[action], id, labelOf(p, p.event.name), { status: p.status }, { status: moved.next.status });
}

/** Hide from the wall, or from the album: two flags, each set on its own. */
export async function setHidden(tx: Tx, ctx: Ctx, id: string, where: 'wall' | 'album', hidden: boolean) {
  const p = await tx.photo.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, include: { event: { select: { name: true } } } });
  if (p.purgedAt) throw new Refused(MODERATION_PROBLEM.purged);
  const field = where === 'wall' ? 'hiddenFromWall' : 'hiddenFromAlbum';
  if (p[field] === hidden) throw new Refused(hidden ? `That photo is already hidden from the ${where}.` : `That photo is not hidden from the ${where}.`);
  await tx.photo.update({ where: { id }, data: { [field]: hidden } });
  await logChange(tx, ctx, 'photo', hidden ? 'hidden' : 'shown', id, labelOf(p, p.event.name), { [field]: p[field] }, { [field]: hidden });
}

/** Blocks (or unblocks) a device: its uploads are refused from now on. What it already sent stays where it is. */
export async function setDeviceBlocked(tx: Tx, ctx: Ctx & { userId: string }, deviceId: string, blocked: boolean) {
  const d = await tx.photoDevice.findFirstOrThrow({ where: { id: deviceId, ...inOrg(ctx) }, include: { event: { select: { name: true } } } });
  if ((d.blockedAt !== null) === blocked) throw new Refused(blocked ? 'That device is already blocked.' : 'That device is not blocked.');
  await tx.photoDevice.update({ where: { id: deviceId }, data: blocked ? { blockedAt: now(), blockedById: ctx.userId } : { blockedAt: null, blockedById: null } });
  await logChange(tx, ctx, 'photodevice', blocked ? 'blocked' : 'unblocked', deviceId, `A device at ${d.event.name}`, { blocked: !blocked }, { blocked });
}

// ---- reads

export type EventRow = {
  id: string; name: string; mode: Mode; uploadsOpen: boolean; uploadDays: number; retentionDays: number;
  lastUploadDay: Day; lastKeptDay: Day; linkOpen: boolean; purgeDue: boolean;
  counts: { pending: number; live: number; removed: number; purged: number };
};

export async function loadEvents(tx: Tx, ctx: { orgId: string }): Promise<EventRow[]> {
  const wedding = await requireWedding(tx, ctx);
  const date = weddingDay(wedding);
  const today = todayOf(wedding);
  const events = await tx.photoEvent.findMany({ where: inOrg(ctx), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const byStatus = await tx.photo.groupBy({ by: ['eventId', 'status'], where: { ...inOrg(ctx), purgedAt: null }, _count: { _all: true } });
  const purged = await tx.photo.groupBy({ by: ['eventId'], where: { ...inOrg(ctx), purgedAt: { not: null } }, _count: { _all: true } });
  const n = (eventId: string, status: string) => byStatus.find((r) => r.eventId === eventId && r.status === status)?._count._all ?? 0;
  return events.map((e) => ({
    id: e.id, name: e.name, mode: e.mode, uploadsOpen: e.uploadsOpen, uploadDays: e.uploadDays, retentionDays: e.retentionDays,
    lastUploadDay: lastUploadDay(date, e.uploadDays), lastKeptDay: lastKeptDay(date, e.retentionDays), linkOpen: linkOpen(e, date, today), purgeDue: purgeDue(e, date, today),
    counts: { pending: n(e.id, 'pending'), live: n(e.id, 'live'), removed: n(e.id, 'removed'), purged: purged.find((r) => r.eventId === e.id)?._count._all ?? 0 },
  }));
}

const PHOTO_FIELDS = { id: true, uploaderName: true, caption: true, status: true, removedFrom: true, hiddenFromWall: true, hiddenFromAlbum: true, width: true, height: true, createdAt: true, purgedAt: true, deviceId: true } as const;

/** Everything the moderation console shows for one event: the queue, what is live, what was removed, and the devices. */
export async function loadConsole(tx: Tx, ctx: { orgId: string }, eventId: string) {
  const photos = await tx.photo.findMany({ where: { ...inOrg(ctx), eventId, purgedAt: null }, select: PHOTO_FIELDS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const devices = await tx.photoDevice.findMany({ where: { ...inOrg(ctx), eventId }, select: { id: true, blockedAt: true, createdAt: true, _count: { select: { photos: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const number = new Map(devices.map((d, i) => [d.id, i + 1]));
  const rows = photos.map((p) => ({ ...p, device: number.get(p.deviceId) ?? 0 }));
  return {
    queue: rows.filter((p) => p.status === 'pending').reverse(), // oldest first: decide in the order they arrived
    live: rows.filter((p) => p.status === 'live'),
    removed: rows.filter((p) => p.status === 'removed'),
    devices: devices.map((d) => ({ id: d.id, number: number.get(d.id)!, blocked: d.blockedAt !== null, photos: d._count.photos })),
  };
}

const shown = (p: { status: 'pending' | 'live' | 'removed'; hiddenFromWall: boolean; hiddenFromAlbum: boolean; purgedAt: Date | null }) => ({ status: p.status, hiddenFromWall: p.hiddenFromWall, hiddenFromAlbum: p.hiddenFromAlbum, purged: p.purgedAt !== null });

/** The album: live photos not hidden from the album, oldest first. */
export async function loadAlbum(tx: Tx, ctx: { orgId: string }, eventId: string) {
  const photos = await tx.photo.findMany({ where: { ...inOrg(ctx), eventId, status: 'live', purgedAt: null }, select: PHOTO_FIELDS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return photos.filter((p) => inAlbum(shown(p)));
}

/** The wall feed: live photos not hidden from the wall, NEWEST FIRST (wall.ts decides what shows next). */
export async function wallFeed(tx: Tx, ctx: { orgId: string }, eventId: string) {
  const photos = await tx.photo.findMany({ where: { ...inOrg(ctx), eventId, status: 'live', purgedAt: null }, select: PHOTO_FIELDS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return photos.filter((p) => onWall(shown(p))).map((p) => ({ id: p.id, by: p.uploaderName, caption: p.caption }));
}

/** The whole gallery as one zip: the full rendition of every album-visible photo, and a text file of names and captions. */
export async function albumZip(tx: Tx, ctx: { orgId: string }, eventId: string, at: ZipTime): Promise<Uint8Array> {
  const photos = await loadAlbum(tx, ctx, eventId);
  const files = [];
  const lines = [];
  for (const [i, p] of photos.entries()) {
    const bytes = await readBlob(tx, ctx.orgId, p.id, 'full');
    if (!bytes) continue;
    const name = `photo-${String(i + 1).padStart(4, '0')}.jpg`;
    files.push({ name, data: bytes });
    lines.push([name, p.uploaderName, p.caption].join('\t'));
  }
  try {
    return zipStored([...files, { name: 'captions.txt', data: new TextEncoder().encode(['file\tfrom\tcaption', ...lines].join('\n') + '\n') }], at);
  } catch (e) {
    if (e instanceof RangeError) throw new Refused('This gallery is too large for one download.');
    throw e;
  }
}

/**
 * The retention purge (rule 1: the day is derived, `retentionDays` after the wedding date). For every event past its
 * last kept day: the bytes of every photo are deleted and the photo is marked purged. The row stays (who, when, the
 * caption), so the log still reads; the picture is gone for good. Returns how many photos were purged.
 */
export async function purgeExpired(tx: Tx, ctx: Ctx): Promise<number> {
  const wedding = await tx.wedding.findUnique({ where: { orgId: ctx.orgId } });
  if (!wedding) return 0;
  const date = weddingDay(wedding);
  const today = todayOf(wedding);
  let total = 0;
  for (const e of await tx.photoEvent.findMany({ where: inOrg(ctx), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) {
    if (!purgeDue(e, date, today)) continue;
    const ids = (await tx.photo.findMany({ where: { ...inOrg(ctx), eventId: e.id, purgedAt: null }, select: { id: true } })).map((p) => p.id);
    if (!ids.length) continue;
    await deleteBlobs(tx, ctx.orgId, ids);
    await tx.photo.updateMany({ where: { ...inOrg(ctx), id: { in: ids } }, data: { purgedAt: now() } });
    await logChange(tx, ctx, 'photoevent', 'purged', e.id, e.name, null, { photosPurged: ids.length, lastKeptDay: lastKeptDay(date, e.retentionDays) });
    total += ids.length;
  }
  return total;
}
