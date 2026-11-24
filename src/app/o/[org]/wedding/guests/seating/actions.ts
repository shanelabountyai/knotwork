'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { loadWho, need } from '@/lib/knotwork/context';
import { addRule, addTable, clearSeats, generateSeating, moveGuest, removeRule, removeTable, SEED_MAX, setLocked, setSeatPending, TABLE_NAME_MAX, updateTable } from '@/lib/knotwork/seating/store';

// P1-5, the seating chart. A guest-list feature: `guests.edit` writes (a helper with the guest-list grant may), and
// nothing here is guest-facing. Order as everywhere: capability, then every ref (another workspace's row is notFound,
// like one that does not exist), then the rules (Refused, in the store), then the writes and their change-log lines in
// one transaction under the wedding lock (in the store).

const page = (ctx: OrgCtx, rest = '') => `/o/${ctx.slug}/wedding/guests/seating${rest}`;
const whole = (label: string, min: number, max: number) =>
  z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
    const n = typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) c.addIssue({ code: 'custom', message: `${label}: a whole number from ${min} to ${max}.` });
    return n;
  });
const tableName = z.string().trim().min(1, 'Give the table a name.').max(TABLE_NAME_MAX, 'That name is too long.');
const capacity = whole('Seats', 1, 30);
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');
const optionalTable = z.union([ref('seatingTable'), z.literal('')]).optional().transform((v) => v || null);

const tableIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.seatingTable.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const ruleIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.seatingRule.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const guestIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.guest.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
async function editing(tx: Tx, ctx: OrgCtx) {
  need(await loadWho(tx, ctx), 'guests.edit');
}

export const addSeatingTable = orgAction(null, z.object({ name: tableName, capacity }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await addTable(tx, ctx, i);
  });
  redirect(page(ctx));
});

export const updateSeatingTable = orgAction(null, z.object({ id: ref('seatingTable'), name: tableName, capacity }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await tableIn(tx, ctx, i.id);
    await updateTable(tx, ctx, i.id, { name: i.name, capacity: i.capacity });
  });
  redirect(page(ctx));
});

export const removeSeatingTable = orgAction(null, z.object({ id: ref('seatingTable') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await tableIn(tx, ctx, i.id);
    await removeTable(tx, ctx, i.id);
  });
  redirect(page(ctx));
});

export const addSeatingRule = orgAction(null, z.object({ a: ref('guest'), b: ref('guest'), kind: z.enum(['apart', 'together']), hard: checkbox }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await guestIn(tx, ctx, i.a);
    await guestIn(tx, ctx, i.b);
    await addRule(tx, ctx, i);
  });
  redirect(page(ctx));
});

export const removeSeatingRule = orgAction(null, z.object({ id: ref('seatingRule') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await ruleIn(tx, ctx, i.id);
    await removeRule(tx, ctx, i.id);
  });
  redirect(page(ctx));
});

/** A manual move: to a table (the seat is then locked), or to no table. */
export const moveSeatedGuest = orgAction(null, z.object({ guestId: ref('guest'), tableId: optionalTable }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await guestIn(tx, ctx, i.guestId);
    if (i.tableId) await tableIn(tx, ctx, i.tableId);
    await moveGuest(tx, ctx, i.guestId, i.tableId);
  });
  redirect(page(ctx));
});

export const lockSeat = orgAction(null, z.object({ guestId: ref('guest'), locked: checkbox }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await guestIn(tx, ctx, i.guestId);
    await setLocked(tx, ctx, i.guestId, i.locked);
  });
  redirect(page(ctx));
});

export const seatPendingGuests = orgAction(null, z.object({ on: checkbox }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await setSeatPending(tx, ctx, i.on);
  });
  redirect(page(ctx));
});

/** Generates a seating (locked seats stay). The same arrangement number on the same chart gives the same seating. */
export const generateSeatingChart = orgAction(null, z.object({ seed: whole('Arrangement number', 1, SEED_MAX) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await generateSeating(tx, ctx, i.seed);
  });
  redirect(page(ctx, `?arrangement=${i.seed}`));
});

export const clearUnlockedSeats = orgAction(null, z.object({}), async (ctx) => {
  await withOrg(ctx, async (tx) => {
    await editing(tx, ctx);
    await clearSeats(tx, ctx);
  });
  redirect(page(ctx));
});
