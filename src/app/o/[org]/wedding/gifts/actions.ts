'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { loadWho, need, requireWedding, todayOf } from '@/lib/knotwork/context';
import { isRealDay } from '@/lib/knotwork/days';
import { GIFT_MIN_CENTS, TARGET_MAX_CENTS } from '@/lib/knotwork/gifts/ledger';
import { acknowledgeThankYou as acknowledgeRow, addItem, closeRegistry as closeRows, updateItem } from '@/lib/knotwork/gifts/store';
import { parseCents, usd } from '@/lib/knotwork/money';
import { checkStoreUrl, isQuantity, parseQuantity, PRICE_MAX_CENTS, QUANTITY_MAX, STORE_MAX, TITLE_MAX, URL_MAX, URL_PROBLEM } from '@/lib/knotwork/registry/links';
import { acknowledgeClaim as acknowledgeClaimRow, addLink, removeLink, updateLink } from '@/lib/knotwork/registry/store';
import { acknowledgeGift as acknowledgeGiftRow, logGift, removeGift } from '@/lib/knotwork/thanks/store';

// The couple's side of group gifting (PRD P0-5). Same order as every other action: capability, every ref (another
// org's row is notFound), the rules, then the write and its change-log line (in the store). Nothing here is
// guest-facing: a household's contribution comes in through /r/[token]/gifts. And nothing here reads the ledger: the
// couple never sees what one household gave (tests/knotwork/structure.test.ts scans this folder).

const page = (ctx: OrgCtx, rest = '') => `/o/${ctx.slug}/wedding/gifts${rest}`;
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');
const TARGET_TEXT = `Target: an amount from ${usd(GIFT_MIN_CENTS)} to ${usd(TARGET_MAX_CENTS)}, like 450.00.`;
const target = z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
  const cents = typeof v === 'number' ? v : parseCents(v);
  if (cents === null || !Number.isInteger(cents) || cents < 0 || cents > TARGET_MAX_CENTS) c.addIssue({ code: 'custom', message: TARGET_TEXT });
  return cents ?? 0;
});
/** The lower bound is a rule, not a shape: it is checked after every ref has resolved (another org's row is notFound first). */
const atLeastMinimum = (cents: number) => {
  if (cents < GIFT_MIN_CENTS) throw new Refused(TARGET_TEXT);
};
const itemFields = { title: z.string().trim().min(1, 'A title is required.').max(120, 'That title is too long.'), note: z.string().trim().max(300, 'That note is too long.').default(''), target };

const itemIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.registryItem.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const thankYouIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.thankYou.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();

export const addRegistryItem = orgAction(null, z.object(itemFields), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await requireWedding(tx, ctx);
    atLeastMinimum(i.target);
    await addItem(tx, ctx, { title: i.title, note: i.note, targetCents: i.target });
  });
  redirect(page(ctx));
});

export const updateRegistryItem = orgAction(null, z.object({ id: ref('registryItem'), ...itemFields }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await itemIn(tx, ctx, i.id);
    atLeastMinimum(i.target);
    await updateItem(tx, ctx, i.id, { title: i.title, note: i.note, targetCents: i.target });
  });
  redirect(page(ctx));
});

/** Closes every open gift and refunds what was given toward each. One partner, with the box ticked (D-72). */
export const closeRegistry = orgAction(null, z.object({ confirm: checkbox }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await requireWedding(tx, ctx);
    if (!i.confirm) throw new Refused('Tick the box to close the registry. Every open gift is closed and everything given toward it is refunded; this cannot be undone.');
    await closeRows(tx, ctx);
  });
  redirect(page(ctx));
});

export const acknowledgeThankYou = orgAction(null, z.object({ id: ref('thankYou') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await thankYouIn(tx, ctx, i.id);
    await acknowledgeRow(tx, ctx, i.id);
  });
  redirect(page(ctx, '/thank-yous'));
});

// ---- P1-8: link-out items (things bought from a store). The URL is checked in full after every ref has resolved.

const linkIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.registryLink.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const PRICE_TEXT = `Price: leave it empty, or an amount up to ${usd(PRICE_MAX_CENTS)}, like 89.99.`;
const WANTED_TEXT = `How many: a whole number from 1 to ${QUANTITY_MAX}.`;
const price = z.union([z.number().int(), z.string().max(40)]).optional().transform((v, c) => {
  if (v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const cents = typeof v === 'number' ? v : parseCents(v);
  if (cents === null || !Number.isInteger(cents) || cents < 0) c.addIssue({ code: 'custom', message: PRICE_TEXT });
  return cents ?? 0;
});
const wanted = z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
  const n = parseQuantity(v);
  if (n === null) c.addIssue({ code: 'custom', message: WANTED_TEXT });
  return n ?? 0;
});
const linkFields = {
  title: z.string().trim().min(1, 'A title is required.').max(TITLE_MAX, 'That title is too long.'),
  store: z.string().trim().min(1, 'The store\'s name is required.').max(STORE_MAX, 'That store name is too long.'),
  url: z.string().max(URL_MAX * 2, URL_PROBLEM.long),
  price,
  wanted,
};
/** The rules on a link's values, checked after the refs: the URL in full, the price and the quantity within bounds. */
function checkedLink(i: { title: string; store: string; url: string; price: number | null; wanted: number }) {
  const u = checkStoreUrl(i.url);
  if (!u.ok) throw new Refused(URL_PROBLEM[u.why]);
  if (i.price !== null && (i.price < 1 || i.price > PRICE_MAX_CENTS)) throw new Refused(PRICE_TEXT);
  if (!isQuantity(i.wanted)) throw new Refused(WANTED_TEXT);
  return { title: i.title, store: i.store, url: u.href, priceCents: i.price, quantityWanted: i.wanted };
}

export const addRegistryLink = orgAction(null, z.object(linkFields), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await requireWedding(tx, ctx);
    await addLink(tx, ctx, checkedLink(i));
  });
  redirect(page(ctx));
});

export const updateRegistryLink = orgAction(null, z.object({ id: ref('registryLink'), ...linkFields }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await linkIn(tx, ctx, i.id);
    await updateLink(tx, ctx, i.id, checkedLink(i));
  });
  redirect(page(ctx));
});

export const removeRegistryLink = orgAction(null, z.object({ id: ref('registryLink') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await linkIn(tx, ctx, i.id);
    await removeLink(tx, ctx, i.id);
  });
  redirect(page(ctx));
});

// ---- P1-3: the thank-you ledger. A gift logged by hand, and "sent" for each kind of obligation.

const optionalRef = (model: string) => z.union([ref(model), z.literal('')]).optional().transform((v) => v || null);
const dayOrToday = z.union([z.literal(''), z.string().trim().max(10)]).default('');
const giftIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.giftLog.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();
const claimIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.registryClaim.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true } })) ?? notFound();

export const logReceivedGift = orgAction(
  null,
  z.object({ householdId: optionalRef('household'), giverName: z.string().trim().max(120, 'That name is too long.').default(''), what: z.string().trim().min(1, 'Say what the gift was.').max(200, 'That is too long.'), receivedOn: dayOrToday }),
  async (ctx, i) => {
    await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'gifts.edit');
      if (i.householdId && !(await tx.household.findFirst({ where: { id: i.householdId, ...inOrg(ctx) }, select: { id: true } }))) notFound();
      const today = todayOf(await requireWedding(tx, ctx));
      if (i.householdId && i.giverName) throw new Refused('Choose a household or type a name, not both.');
      if (!i.householdId && !i.giverName) throw new Refused('Say who it is from: choose a household or type a name.');
      const on = i.receivedOn === '' ? today : i.receivedOn;
      if (!isRealDay(on)) throw new Refused('Pick a real date.');
      if (on > today) throw new Refused('Received is a fact: pick today or a day before.');
      await logGift(tx, ctx, { householdId: i.householdId, giverName: i.giverName, what: i.what, receivedOn: on });
    });
    redirect(page(ctx, '/thank-yous'));
  },
);

export const removeReceivedGift = orgAction(null, z.object({ id: ref('giftLog') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await giftIn(tx, ctx, i.id);
    await removeGift(tx, ctx, i.id);
  });
  redirect(page(ctx, '/thank-yous'));
});

export const acknowledgeReceivedGift = orgAction(null, z.object({ id: ref('giftLog') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await giftIn(tx, ctx, i.id);
    await acknowledgeGiftRow(tx, ctx, i.id);
  });
  redirect(page(ctx, '/thank-yous'));
});

export const acknowledgeClaim = orgAction(null, z.object({ id: ref('registryClaim') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'gifts.edit');
    await claimIn(tx, ctx, i.id);
    await acknowledgeClaimRow(tx, ctx, i.id);
  });
  redirect(page(ctx, '/thank-yous'));
});
