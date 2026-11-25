'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { loadWho, need, requireWedding } from '@/lib/knotwork/context';
import { EVENT_DEFAULTS } from '@/lib/knotwork/photos/dates';
import { CLASSIFIERS } from '@/lib/knotwork/photos/classifier';
import { ACTIONS, MODES } from '@/lib/knotwork/photos/moderation';
import { createEvent, moderatePhoto as moderateRow, purgeExpired, replaceLink, setDeviceBlocked, setHidden, setUploadsOpen, updateEvent } from '@/lib/knotwork/photos/store';

// The couple's and the moderators' side of the photo wall (PRD P0-6). Same order as every other action: capability,
// every ref (another org's row is notFound), the rules, then the write and its change-log line (in the store).
// Nothing here takes a file: a photo arrives only through /p/[token]/upload (rule 4), and nothing here is guest-facing.
// Making an event, its settings, its link and the purge are the partners' (photos.manage); moderating is anyone's
// with photos.moderate (a partner, or a helper with the photos_moderate grant).

const page = (ctx: OrgCtx, rest = '') => `/o/${ctx.slug}/wedding/photos${rest}`;
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');
/** A whole number of days. The bounds are rules, checked in the store after every ref has resolved. */
const days = (fallback: number) =>
  z.union([z.number().int(), z.string().max(8)]).default(fallback).transform((v, c) => {
    const n = typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n)) c.addIssue({ code: 'custom', message: 'Days: a whole number.' });
    return n;
  });
const eventFields = { name: z.string().trim().min(1, 'A name is required.').max(80, 'That name is too long.'), mode: z.enum(MODES).default('post'), uploadDays: days(EVENT_DEFAULTS.uploadDays), retentionDays: days(EVENT_DEFAULTS.retentionDays), classifier: z.enum(CLASSIFIERS).default('none') };

const eventIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.photoEvent.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const photoIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.photo.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, eventId: true } })) ?? notFound();
const deviceIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.photoDevice.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, eventId: true } })) ?? notFound();

export const createPhotoEvent = orgAction(null, z.object(eventFields), async (ctx, i) => {
  const event = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.manage');
    return createEvent(tx, ctx, i);
  });
  redirect(page(ctx, `/${event.id}`));
});

export const updatePhotoEvent = orgAction(null, z.object({ id: ref('photoEvent'), ...eventFields }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.manage');
    await eventIn(tx, ctx, i.id);
    await updateEvent(tx, ctx, i.id, { name: i.name, mode: i.mode, uploadDays: i.uploadDays, retentionDays: i.retentionDays, classifier: i.classifier });
  });
  redirect(page(ctx, `/${i.id}`));
});

/** Opens or closes uploads by hand. Closed, the link and its QR code answer 404 at once. */
export const setPhotoUploads = orgAction(null, z.object({ id: ref('photoEvent'), open: z.enum(['open', 'closed']) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.manage');
    await eventIn(tx, ctx, i.id);
    await setUploadsOpen(tx, ctx, i.id, i.open === 'open');
  });
  redirect(page(ctx, `/${i.id}`));
});

/** Replaces the upload link: the printed QR code stops working at once (a link that got out). */
export const replacePhotoLink = orgAction(null, z.object({ id: ref('photoEvent'), confirm: checkbox }), async (ctx, i) => {
  const url = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.manage');
    await eventIn(tx, ctx, i.id);
    if (!i.confirm) throw new Refused('Tick the box to replace the link. The link and QR code already handed out stop working at once.');
    return replaceLink(tx, ctx, i.id);
  });
  return { notice: `${url} is the new link. The earlier link and its QR code no longer work. Reload this page for the new QR code.` };
});

/** Approve, reject, take down, or undo (the pure machine decides whether the move is legal). */
export const moderatePhoto = orgAction(null, z.object({ id: ref('photo'), action: z.enum(ACTIONS) }), async (ctx, i) => {
  const eventId = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.moderate');
    const p = await photoIn(tx, ctx, i.id);
    await moderateRow(tx, ctx, i.id, i.action);
    return p.eventId;
  });
  redirect(page(ctx, `/${eventId}/moderate`));
});

/** Hide from the wall, or from the album. The two are separate: a photo can be in one and not the other. */
export const setPhotoHidden = orgAction(null, z.object({ id: ref('photo'), where: z.enum(['wall', 'album']), hidden: z.enum(['yes', 'no']) }), async (ctx, i) => {
  const eventId = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.moderate');
    const p = await photoIn(tx, ctx, i.id);
    await setHidden(tx, ctx, i.id, i.where, i.hidden === 'yes');
    return p.eventId;
  });
  redirect(page(ctx, `/${eventId}/moderate`));
});

/** Blocks, or unblocks, the device a photo came from. */
export const setPhotoDeviceBlocked = orgAction(null, z.object({ id: ref('photoDevice'), blocked: z.enum(['yes', 'no']) }), async (ctx, i) => {
  const eventId = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.moderate');
    const d = await deviceIn(tx, ctx, i.id);
    await setDeviceBlocked(tx, ctx, i.id, i.blocked === 'yes');
    return d.eventId;
  });
  redirect(page(ctx, `/${eventId}/moderate`));
});

/** The retention purge, by hand (the cron job runs the same function): only events past their last kept day. */
export const purgeExpiredPhotos = orgAction(null, z.object({ confirm: checkbox }), async (ctx, i) => {
  const purged = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'photos.manage');
    await requireWedding(tx, ctx);
    if (!i.confirm) throw new Refused('Tick the box to delete the photos that are past their last kept day. This cannot be undone.');
    const n = await purgeExpired(tx, ctx);
    if (n === 0) throw new Refused('Nothing to delete: no photo is past its last kept day.');
    return n;
  });
  return { notice: `${purged} ${purged === 1 ? 'photo was' : 'photos were'} deleted for good.` };
});
