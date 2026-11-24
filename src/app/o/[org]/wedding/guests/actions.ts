'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { logChange } from '@/lib/knotwork/changelog';
import { hasPending, propose } from '@/lib/knotwork/consent/store';
import { loadWho, need, requireWedding, todayOf } from '@/lib/knotwork/context';
import { dbOfDay } from '@/lib/knotwork/days';
import { parseCents } from '@/lib/knotwork/money';
import { parseGuestCsv } from '@/lib/knotwork/guests/csv';
import { ACCESSIBILITY, checkRsvp, DIETARY, rsvpView } from '@/lib/knotwork/guests/projection';
import {
  addGuest as addGuestRow, addHousehold as addHouseholdRow, applyLockout, applyRsvp, clearRsvp, importHouseholds, loadPlan, markCalled as markCalledRow, releaseWave as releaseWaveRows,
  replaceRsvpLink, rsvpDeadline, rsvpLink, savePlan, sendDueReminders, updateGuest as updateGuestRow, updateHousehold as updateHouseholdRow,
} from '@/lib/knotwork/guests/store';

// Guest-list writes (PRD P0-3, P0-4). Same order as the Phase 1 actions: capability, every ref (another org's row is
// notFound), the rules, then the write and its change-log line. A guest REMOVAL is designated: it is proposed here and
// done by consent/execute.ts. Nothing here is guest-facing; a guest's own reply comes in through /r/[token].

const page = (ctx: OrgCtx, rest = '') => `/o/${ctx.slug}/wedding/guests${rest}`;
const text = (label: string, max = 120) => z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);
const note = (max = 200) => z.string().trim().max(max).default('');
const whole = (label: string, min: number, max: number) =>
  z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
    const n = typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) c.addIssue({ code: 'custom', message: `${label}: a whole number from ${min} to ${max}.` });
    return n;
  });
const optionalWhole = (label: string, max: number) =>
  z.union([z.number().int(), z.string().max(40)]).optional().transform((v, c) => {
    if (v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > max) c.addIssue({ code: 'custom', message: `${label}: a whole number from 0 to ${max}, or leave it empty.` });
    return n;
  });
const money = (label: string) =>
  z.union([z.number().int(), z.string().max(40)]).transform((v, c) => {
    const cents = typeof v === 'number' ? v : parseCents(v);
    if (cents === null || !Number.isInteger(cents) || cents < 0 || cents > 10_000_000) c.addIssue({ code: 'custom', message: `${label}: an amount like 87.00.` });
    return cents ?? 0;
  });
const checkbox = z.union([z.boolean(), z.string().max(8)]).optional().transform((v) => v === true || v === 'on' || v === 'true' || v === '1');

const householdIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.household.findFirst({ where: { id, ...inOrg(ctx) } })) ?? notFound();
const guestIn = async (tx: Tx, ctx: OrgCtx, id: string) => (await tx.guest.findFirst({ where: { id, ...inOrg(ctx) }, include: { household: true } })) ?? notFound();

export const saveGuestPlan = orgAction(
  null,
  z.object({
    cap: whole('Headcount cap', 0, 5000), venueMin: optionalWhole('Venue minimum', 5000), venueMax: optionalWhole('Venue maximum', 5000),
    perHead: money('Per head'), kidsMeal: money('Kids meal'), vendorMeal: money('Vendor meal'),
    lockoutDays: whole('Lockout', 0, 365), minBatchSeats: whole('Smallest batch', 1, 500), mealOptions: z.string().trim().max(400).default(''),
  }),
  async (ctx, i) => {
    const meals = [...new Set(i.mealOptions.split(',').map((m) => m.trim()).filter(Boolean))];
    if (meals.some((m) => m.length > 40) || meals.length > 12) throw new Refused('Up to 12 meal options, each under 40 characters, separated by commas.');
    await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'guests.edit');
      await requireWedding(tx, ctx);
      await savePlan(tx, ctx, { cap: i.cap, venueMin: i.venueMin, venueMax: i.venueMax, perHeadCents: i.perHead, kidsMealCents: i.kidsMeal, vendorMealCents: i.vendorMeal, lockoutDays: i.lockoutDays, minBatchSeats: i.minBatchSeats, mealOptions: meals.length ? meals : (await loadPlan(tx, ctx)).mealOptions });
    });
    redirect(page(ctx, '/waves'));
  },
);

const householdFields = { name: text('Household name'), email: z.union([z.literal(''), z.email('That email does not look right.').max(200)]).default(''), phone: note(40), address1: note(), city: note(80), region: note(80), postal: note(20), list: z.enum(['A', 'B']), priority: whole('Priority', 0, 9999) };

export const addHousehold = orgAction(null, z.object(householdFields), async (ctx, i) => {
  const id = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    await requireWedding(tx, ctx);
    return (await addHouseholdRow(tx, ctx, i)).id;
  });
  redirect(page(ctx, `/${id}`));
});

export const updateHousehold = orgAction(null, z.object({ id: ref('household'), ...householdFields, plusOneOverride: z.enum(['', 'grant', 'deny']).default(''), plusOneNote: note(300) }), async (ctx, { id, plusOneOverride, ...i }) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    await householdIn(tx, ctx, id);
    await updateHouseholdRow(tx, ctx, id, { ...i, plusOneOverride: plusOneOverride || null });
  });
  redirect(page(ctx, `/${id}`));
});

const guestFields = { name: text('Name'), ageGroup: z.enum(['adult', 'child', 'infant']), partnerStatus: z.enum(['none', 'dating', 'long_distance', 'engaged', 'married']), inWeddingParty: checkbox };

export const addGuest = orgAction(null, z.object({ householdId: ref('household'), ...guestFields }), async (ctx, { householdId, ...i }) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    await householdIn(tx, ctx, householdId);
    await addGuestRow(tx, ctx, householdId, i);
  });
  redirect(page(ctx, `/${householdId}`));
});

export const updateGuest = orgAction(null, z.object({ id: ref('guest'), ...guestFields, privateNote: note(500) }), async (ctx, { id, ...i }) => {
  const householdId = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    const g = await guestIn(tx, ctx, id);
    await updateGuestRow(tx, ctx, id, i);
    return g.householdId;
  });
  redirect(page(ctx, `/${householdId}`));
});

/** The couple records one person's answer on their behalf (a phone call, a note in the post). Checked like a guest's own reply. */
export const recordRsvp = orgAction(
  null,
  z.object({ id: ref('guest'), rsvp: z.enum(['pending', 'attending', 'declined']), meal: note(40), dietary: z.array(z.enum(DIETARY)).default([]), accessibility: z.array(z.enum(ACCESSIBILITY)).default([]), songRequest: note(120) }),
  async (ctx, i) => {
    const householdId = await withOrg(ctx, async (tx) => {
      need(await loadWho(tx, ctx), 'guests.edit');
      const g = await guestIn(tx, ctx, i.id);
      if (g.removedAt) throw new Refused('That guest was removed.');
      if (g.household.state !== 'invited') throw new Refused('This household has not been invited yet.');
      if (i.rsvp === 'pending') {
        await clearRsvp(tx, ctx, g.id);
        return g.householdId;
      }
      const wedding = await requireWedding(tx, ctx);
      const view = rsvpView({
        wedding: { title: wedding.title, date: todayOf(wedding) }, rsvpBy: await rsvpDeadline(tx, ctx, wedding), mealOptions: (await loadPlan(tx, ctx)).mealOptions, household: { name: g.household.name, plusOneAllowed: false },
        guests: [{ id: g.id, name: g.name, ageGroup: g.ageGroup, isPlusOne: g.isPlusOne, rsvp: g.rsvp, meal: g.meal, dietary: g.dietary, accessibility: g.accessibility, songRequest: g.songRequest }],
      });
      const checked = checkRsvp(view, { responses: [{ guestId: g.id, attending: i.rsvp === 'attending', meal: i.meal, dietary: i.dietary, accessibility: i.accessibility, songRequest: i.songRequest }], plusOneName: '' });
      if (!checked.ok) throw new Refused(checked.message);
      await applyRsvp(tx, ctx, g.householdId, checked);
      return g.householdId;
    });
    redirect(page(ctx, `/${householdId}`));
  },
);

/** Shows the household's RSVP link (the raw token exists only in this response and in the sealed copy). */
export const showRsvpLink = orgAction(null, z.object({ id: ref('household') }), async (ctx, i) => {
  const url = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    const h = await householdIn(tx, ctx, i.id);
    if (h.state !== 'invited') throw new Refused('This household has not been invited yet, so it has no link.');
    return rsvpLink(tx, ctx, h.id);
  });
  return { notice: url };
});

/** Replaces the household's RSVP link: the one they were sent stops working at once (a link that leaked, or was forwarded). */
export const newRsvpLink = orgAction(null, z.object({ id: ref('household') }), async (ctx, i) => {
  const url = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    const h = await householdIn(tx, ctx, i.id);
    return replaceRsvpLink(tx, ctx, h.id);
  });
  return { notice: `${url} is the new link. The earlier link no longer works; send this one.` };
});

export const markSaveTheDate = orgAction(null, z.object({ id: ref('household') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    const h = await householdIn(tx, ctx, i.id);
    if (h.saveTheDateSentOn) throw new Refused('The save-the-date is already marked as sent.');
    const on = todayOf(await requireWedding(tx, ctx));
    await tx.household.update({ where: { id: h.id }, data: { saveTheDateSentOn: dbOfDay(on) } });
    await logChange(tx, ctx, 'household', 'updated', h.id, h.name, { saveTheDateSentOn: null }, { saveTheDateSentOn: on });
  });
  redirect(page(ctx, `/${i.id}`));
});

/** Designated (guest-list removals): proposes only. */
export const proposeGuestRemoval = orgAction(null, z.object({ id: ref('guest') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'consent.propose');
    const g = await guestIn(tx, ctx, i.id);
    if (g.removedAt) throw new Refused('That guest was already removed.');
    if (await hasPending(tx, ctx, 'remove_guest', undefined, g.id)) throw new Refused('Removing this guest is already waiting for your partner.');
    await propose(tx, ctx, await requireWedding(tx, ctx), 'remove_guest', { guestIds: [g.id] }, `Remove ${g.name} (${g.household.name}) from the guest list`);
  });
  redirect(`/o/${ctx.slug}/wedding/approvals`);
});

// ---- waves (P0-4)

export const releaseWave = orgAction(null, z.object({ list: z.enum(['A', 'B']) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    await requireWedding(tx, ctx);
    await releaseWaveRows(tx, ctx, i.list);
  });
  redirect(page(ctx, '/waves'));
});

/** Inside the lockout: remaining queued B households become regrets. */
export const closeBList = orgAction(null, z.object({}), async (ctx) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    await requireWedding(tx, ctx);
    if (!(await applyLockout(tx, ctx))) throw new Refused('Nothing to close: either it is not inside the lockout yet, or nobody on the B list is still waiting.');
  });
  redirect(page(ctx, '/waves'));
});

// ---- import (validated, previewed, all or nothing)

export const importGuests = orgAction(null, z.object({ csv: z.string().max(200_000, 'That text is too large (200,000 characters at most).'), confirm: checkbox }), async (ctx, i) => {
  // Who is asking comes before the text is read at all: parsing is work, and a member with no guest-list grant gets none of it.
  await withOrg(ctx, async (tx) => need(await loadWho(tx, ctx), 'guests.edit'));
  const parsed = parseGuestCsv(i.csv);
  if (parsed.errors.length) throw new Refused(`${parsed.errors.slice(0, 8).map((e) => e.message).join(' ')}${parsed.errors.length > 8 ? ` And ${parsed.errors.length - 8} more.` : ''} Nothing was imported.`);
  const guests = parsed.households.reduce((n, h) => n + h.guests.length, 0);
  if (!i.confirm) {
    return { notice: `That would add ${parsed.households.length} households and ${guests} guests (${parsed.households.filter((h) => h.list === 'B').length} households on the B list). Nothing is saved yet: tick the box and import to add them.` };
  }
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    await requireWedding(tx, ctx);
    await importHouseholds(tx, ctx, parsed.households);
  });
  redirect(page(ctx));
});

// ---- chasing (P0-3)

export const sendReminders = orgAction(null, z.object({}), async (ctx) => {
  const n = await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    return sendDueReminders(tx, ctx);
  });
  if (!n) throw new Refused('No reminder is due today.');
  redirect(page(ctx, '/chase'));
});

export const markCalled = orgAction(null, z.object({ id: ref('household') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    await householdIn(tx, ctx, i.id);
    await markCalledRow(tx, ctx, i.id);
  });
  redirect(page(ctx, '/chase'));
});

// ---- do-not-play (bride review #6)

export const addDoNotPlay = orgAction(null, z.object({ title: text('Song'), artist: note(120) }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    if (await tx.doNotPlay.findFirst({ where: { ...inOrg(ctx), title: i.title, artist: i.artist }, select: { id: true } })) throw new Refused('That song is already on the list.');
    const s = await tx.doNotPlay.create({ data: { orgId: ctx.orgId, title: i.title, artist: i.artist, addedById: ctx.userId } });
    await logChange(tx, ctx, 'song', 'created', s.id, `Do not play: ${i.title}`, null, { title: i.title, artist: i.artist });
  });
  redirect(page(ctx, '/music'));
});

export const removeDoNotPlay = orgAction(null, z.object({ id: ref('doNotPlay') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    need(await loadWho(tx, ctx), 'guests.edit');
    const s = (await tx.doNotPlay.findFirst({ where: { id: i.id, ...inOrg(ctx) } })) ?? notFound();
    await tx.doNotPlay.delete({ where: { id: s.id } });
    await logChange(tx, ctx, 'song', 'deleted', s.id, `Do not play: ${s.title}`, { title: s.title, artist: s.artist }, null);
  });
  redirect(page(ctx, '/music'));
});
