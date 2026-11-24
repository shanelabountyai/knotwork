import { pathToFileURL } from 'node:url';
import { sealSecret } from '@/core/auth/secret-box';
import { now } from '@/core/clock';
import { db } from '@/core/db'; // importing it is what refuses a cloud database (INV-18)
import { withOrg, type Tx } from '@/core/db/rls';
import { createExpense, takeSnapshot } from '@/lib/knotwork/budget-store';
import { logChange } from '@/lib/knotwork/changelog';
import { decide, propose } from '@/lib/knotwork/consent/store';
import { requireWedding } from '@/lib/knotwork/context';
import { addDays, dbOfDay, todayIn, type Day } from '@/lib/knotwork/days';
import { addItem, contribute } from '@/lib/knotwork/gifts/store';
import { applyRsvp, importHouseholds, releaseWave, savePlan } from '@/lib/knotwork/guests/store';
import { createWedding } from '@/lib/knotwork/schedule/store';
import { addPayment, generateBrief, updateVendor } from '@/lib/knotwork/vendors/store';
import { DEMO_TOTP_SECRET } from '../seed-demo';

// `npm run seed:couple` (after db:setup; independent of seed:demo): the Knotwork demo seed (PRD Phase 1 gate).
// ONE SYNTHETIC COUPLE. Every person, vendor, address and amount here is invented; none is a real person or business.
//   Juniper Vale and Rowan Ashby: the two partners (both owners).  Maple Okafor: a helper who can see the budget.
//   The wedding is 330 days from today (America/Chicago), from the default template, so the demo move of six weeks
//   has room. Venue and caterer are booked, each by a real two-key request (Juniper proposes, Rowan approves); the
//   florist is still being considered.
// The three accounts are marked isDemo so /demo can sign them in (D-18): such an account only resolves while
// DEMO_MODE=1. Idempotent: the workspace is deleted and rebuilt. One org at a time through withOrg (INV-32).

export const COUPLE = {
  slug: 'juniper-rowan',
  name: 'Juniper & Rowan',
  timeZone: 'America/Chicago',
  daysOut: 330,
  juniper: { email: 'juniper@knotwork.demo.test', name: 'Juniper Vale' },
  rowan: { email: 'rowan@knotwork.demo.test', name: 'Rowan Ashby' },
  maple: { email: 'maple@knotwork.demo.test', name: 'Maple Okafor' },
} as const;

type Ctx = { orgId: string; userId: string; role: 'owner' };

async function user(p: { email: string; name: string }, mfa: boolean) {
  const data = { isDemo: true, name: p.name, ...(mfa && { totpSecretSealed: sealSecret(DEMO_TOTP_SECRET, 'totp'), totpEnrolledAt: now(), totpLastStep: null }) };
  return db.user.upsert({ where: { email: p.email }, create: { email: p.email, ...data }, update: data });
}

/** Juniper proposes, Rowan approves: the same two functions the actions use, so the seeded rows are real two-key rows. */
async function twoKey(tx: Tx, a: Ctx, b: Ctx, kind: Parameters<typeof propose>[3], payload: Parameters<typeof propose>[4], summary: string) {
  const r = await propose(tx, a, await requireWedding(tx, a), kind, payload, summary);
  const d = await decide(tx, b, r.id, 'approve');
  if (!d.ok) throw new Error(`seed: ${summary}: ${d.message}`);
}

export async function seedCouple(opts: { today?: Day } = {}): Promise<string[]> {
  const today = opts.today ?? todayIn(COUPLE.timeZone, now());
  const date = addDays(today, COUPLE.daysOut);
  const old = await db.org.findUnique({ where: { slug: COUPLE.slug }, select: { id: true } });
  if (old) await withOrg({ orgId: old.id }, (tx) => tx.org.delete({ where: { id: old.id } }));

  const [juniper, rowan, maple] = [await user(COUPLE.juniper, true), await user(COUPLE.rowan, true), await user(COUPLE.maple, false)];
  const orgId = crypto.randomUUID();
  await withOrg({ orgId }, async (tx) => {
    await tx.org.create({ data: { id: orgId, slug: COUPLE.slug, name: COUPLE.name } });
    await tx.membership.createMany({ data: [{ orgId, userId: juniper.id, role: 'owner' }, { orgId, userId: rowan.id, role: 'owner' }, { orgId, userId: maple.id, role: 'member' }] });
  });
  const a: Ctx = { orgId, userId: juniper.id, role: 'owner' };
  const b: Ctx = { orgId, userId: rowan.id, role: 'owner' };

  await withOrg({ orgId }, (tx) => createWedding(tx, a, { title: COUPLE.name, date, timeZone: COUPLE.timeZone }));

  // Budget: five categories, in integer cents.
  const categories = new Map<string, string>();
  await withOrg({ orgId }, async (tx) => {
    for (const [name, estimateCents] of [['Venue', 950_000], ['Catering', 1_200_000], ['Flowers', 300_000], ['Music', 250_000], ['Attire', 400_000]] as const) {
      const c = await tx.budgetCategory.create({ data: { orgId, name, estimateCents } });
      categories.set(name, c.id);
      await logChange(tx, a, 'category', 'created', c.id, name, null, { name, estimateCents });
    }
  });

  // Vendors: created and scoped by Juniper; venue and caterer booked with both keys; the florist only considered.
  const vendors = new Map<string, string>();
  for (const v of [
    { name: 'Cedar Hollow Barn', category: 'venue', contactName: 'Imogen Tate', email: 'events@cedarhollow.example', phone: '918-555-0111', deliverables: 'Barn and lawn from noon to midnight, tables and chairs for the estimate, parking attendants', arriveMin: 720, departMin: 1439, countEstimate: 120, countDueDaysBefore: 21, onSite: false },
    { name: 'Fennel & Fig Catering', category: 'caterer', contactName: 'Sam Halloran', email: 'sam@fennelfig.example', phone: '918-555-0142', deliverables: 'Plated dinner for the estimate, two servers, cake cutting', arriveMin: 900, departMin: 1320, countEstimate: 120, countDueDaysBefore: 14, onSite: true },
    { name: 'Wild Rye Flowers', category: 'florist', contactName: 'Petra Novak', email: 'hello@wildrye.example', phone: '918-555-0167', deliverables: 'Ceremony arch, twelve table arrangements, two bouquets', arriveMin: 600, departMin: 780, countEstimate: null, countDueDaysBefore: null, onSite: false },
  ] as const) {
    await withOrg({ orgId }, async (tx) => {
      const { name, category, ...rest } = v;
      const row = await tx.vendor.create({ data: { orgId, name, category } });
      vendors.set(name, row.id);
      await logChange(tx, a, 'vendor', 'created', row.id, name, null, { name, category, status: 'considering' });
      await updateVendor(tx, a, row.id, rest);
    });
  }
  for (const name of ['Cedar Hollow Barn', 'Fennel & Fig Catering']) {
    await withOrg({ orgId }, (tx) => twoKey(tx, a, b, 'book_vendor', { vendorId: vendors.get(name)! }, `Book ${name}`));
  }
  await withOrg({ orgId }, (tx) => twoKey(tx, b, a, 'sign_contract', { vendorId: vendors.get('Cedar Hollow Barn')!, totalCents: 900_000 }, 'Sign the contract with Cedar Hollow Barn for $9,000.00'));

  // Payments are scheduled tasks. The venue deposit is over the threshold, so paying it took both partners.
  await withOrg({ orgId }, async (tx) => {
    const deposit = await addPayment(tx, a, vendors.get('Cedar Hollow Barn')!, { label: 'Deposit', amountCents: 200_000, dueDaysBefore: 300 });
    await addPayment(tx, a, vendors.get('Cedar Hollow Barn')!, { label: 'Balance', amountCents: 700_000, dueDaysBefore: 30 });
    await addPayment(tx, a, vendors.get('Fennel & Fig Catering')!, { label: 'Deposit', amountCents: 150_000, dueDaysBefore: 240 });
    await twoKey(tx, a, b, 'spend', { categoryId: categories.get('Venue')!, vendorId: vendors.get('Cedar Hollow Barn')!, description: 'Cedar Hollow Barn: Deposit', amountCents: 200_000, paidOn: today, paymentId: deposit.id }, 'Spend $2,000.00: Cedar Hollow Barn: Deposit');
    // A small spend one partner records alone.
    await createExpense(tx, b, await requireWedding(tx, b), { categoryId: categories.get('Catering')!, vendorId: vendors.get('Fennel & Fig Catering')!, description: 'Tasting fee', amountCents: 15_000, paidOn: today, paymentId: null }, null);
  });

  // A few template tasks are already done, one is assigned to each of the three.
  await withOrg({ orgId }, async (tx) => {
    for (const key of ['set-budget', 'book-venue', 'book-caterer']) {
      const t = await tx.task.findUniqueOrThrow({ where: { orgId_key: { orgId, key } } });
      await tx.task.update({ where: { id: t.id }, data: { status: 'done', completedOn: dbOfDay(today) } });
      await logChange(tx, a, 'task', 'updated', t.id, t.title, { status: 'todo' }, { status: 'done' });
    }
    for (const [key, who] of [['choose-attire', juniper.id], ['book-music', rowan.id], ['seating-chart', maple.id]] as const) {
      const t = await tx.task.findUniqueOrThrow({ where: { orgId_key: { orgId, key } } });
      await tx.task.update({ where: { id: t.id }, data: { assigneeId: who } });
      await logChange(tx, a, 'task', 'updated', t.id, t.title, { assigneeId: null }, { assigneeId: who });
    }
    const g = await tx.helperGrant.create({ data: { orgId, userId: maple.id, scope: 'budget_view', grantedById: juniper.id } });
    await logChange(tx, a, 'grant', 'granted', g.id, `${COUPLE.maple.email}: See the budget`, null, { userId: maple.id, scope: 'budget_view' });
    await takeSnapshot(tx, a, 'After the venue deposit');
  });

  // Phase 2: the guest list. Cap 12. The A list fills it exactly (12 seats, two of them plus-ones still open); the B
  // list waits. The Lindqvists and the Ashbys have said yes; everyone else has not answered.
  const adult = (name: string, partnerStatus: 'none' | 'married' | 'engaged' = 'married', inWeddingParty = false) => ({ name, ageGroup: 'adult' as const, partnerStatus, inWeddingParty });
  const hh = (name: string, list: 'A' | 'B', priority: number, email: string, phone: string, guests: ReturnType<typeof adult>[] | { name: string; ageGroup: 'adult' | 'child' | 'infant'; partnerStatus: 'none' | 'married' | 'engaged'; inWeddingParty: boolean }[]) =>
    ({ name, list, priority, email, phone, address1: '', city: 'Tulsa', region: 'OK', postal: '', guests });
  await withOrg({ orgId }, async (tx) => {
    await savePlan(tx, a, { cap: 12, venueMin: 8, venueMax: 14, perHeadCents: 8_700, kidsMealCents: 3_500, vendorMealCents: 4_000, lockoutDays: 42, minBatchSeats: 2, mealOptions: ['Chicken', 'Fish', 'Vegetarian'] });
    await importHouseholds(tx, a, [
      hh('The Lindqvists', 'A', 1, 'linda@lindqvist.example', '918-555-0121', [adult('Linda Lindqvist'), adult('Omar Lindqvist'), { name: 'Wren Lindqvist', ageGroup: 'child', partnerStatus: 'none', inWeddingParty: false }]),
      hh('The Ashbys', 'A', 2, 'hal@ashby.example', '918-555-0122', [adult('Hal Ashby'), adult('Io Ashby')]),
      hh('The Vales', 'A', 3, 'ben@vale.example', '918-555-0123', [adult('Ben Vale'), adult('Cy Vale')]),
      hh('Priya Rao', 'A', 4, 'priya@rao.example', '918-555-0124', [adult('Priya Rao', 'engaged')]),
      hh('Dana Kim', 'A', 5, '', '918-555-0125', [adult('Dana Kim', 'none', true)]),
      hh('Ruth Stern', 'A', 6, 'ruth@stern.example', '918-555-0126', [adult('Ruth Stern', 'none')]),
      hh('The Okoros', 'B', 10, 'chidi@okoro.example', '918-555-0131', [adult('Chidi Okoro'), adult('Ngozi Okoro')]),
      hh('The Trans', 'B', 11, 'mai@tran.example', '918-555-0132', [adult('Mai Tran'), adult('Huy Tran')]),
      hh('Sam Webb', 'B', 12, 'sam@webb.example', '918-555-0133', [adult('Sam Webb', 'none')]),
    ]);
    await releaseWave(tx, a, 'A');
    const yes = async (household: string, answers: Record<string, { meal: string | null; dietary?: string[]; accessibility?: string[]; song?: string }>) => {
      const h = await tx.household.findFirstOrThrow({ where: { orgId, name: household }, include: { guests: true } });
      await applyRsvp(tx, { orgId, userId: null }, h.id, { ok: true, plusOneName: null, responses: h.guests.map((g) => ({ guestId: g.id, attending: true, meal: answers[g.name]!.meal, dietary: answers[g.name]!.dietary ?? [], accessibility: answers[g.name]!.accessibility ?? [], songRequest: answers[g.name]!.song ?? '' })) });
    };
    await yes('The Lindqvists', { 'Linda Lindqvist': { meal: 'Fish', dietary: ['gluten_free'], song: 'September' }, 'Omar Lindqvist': { meal: 'Chicken' }, 'Wren Lindqvist': { meal: null, dietary: ['nut_allergy'] } });
    await yes('The Ashbys', { 'Hal Ashby': { meal: 'Chicken', accessibility: ['step_free'] }, 'Io Ashby': { meal: 'Vegetarian', dietary: ['vegetarian'], song: 'Dancing Queen' } });
    const song = await tx.doNotPlay.create({ data: { orgId, title: 'Macarena', addedById: juniper.id } });
    await logChange(tx, a, 'song', 'created', song.id, 'Do not play: Macarena', null, { title: 'Macarena', artist: '' });
  });

  await withOrg({ orgId }, async (tx) => {
    for (const id of vendors.values()) await generateBrief(tx, a, id);
  });

  // Phase 3: the registry. Two pooled gifts (mock money: nothing is charged). The canoe trip is partly funded by two
  // households; the record player is funded, the last offer having been more than was needed (the excess went back),
  // so two thank-yous are owed. Every household and amount is invented.
  await withOrg({ orgId }, async (tx) => {
    const canoe = await addItem(tx, a, { title: 'Honeymoon canoe trip', note: 'Two days on the Buffalo River', targetCents: 60_000 });
    const player = await addItem(tx, b, { title: 'Record player', note: '', targetCents: 20_000 });
    const gives = async (household: string, itemId: string, cents: number) => {
      const h = await tx.household.findFirstOrThrow({ where: { orgId, name: household }, select: { id: true } });
      const r = await contribute(tx, orgId, h.id, itemId, cents);
      if (!r?.ok) throw new Error(`seed: ${household} could not give`);
    };
    await gives('The Lindqvists', canoe.id, 15_000);
    await gives('The Ashbys', canoe.id, 10_000);
    await gives('The Vales', player.id, 12_000);
    await gives('Priya Rao', player.id, 10_000);
  });

  const counts = await withOrg({ orgId }, async (tx) => ({
    tasks: await tx.task.count({ where: { orgId } }),
    vendors: await tx.vendor.count({ where: { orgId } }),
    booked: await tx.vendor.count({ where: { orgId, status: 'booked' } }),
    requests: await tx.consentRequest.count({ where: { orgId } }),
    expenses: await tx.expense.count({ where: { orgId } }),
    households: await tx.household.count({ where: { orgId } }),
    guests: await tx.guest.count({ where: { orgId } }),
    gifts: await tx.registryItem.count({ where: { orgId } }),
    funded: await tx.registryItem.count({ where: { orgId, state: 'funded' } }),
  }));
  return [
    `${COUPLE.name} (/o/${COUPLE.slug}): wedding on ${date}, ${counts.tasks} tasks, ${counts.vendors} vendors (${counts.booked} booked), ${counts.expenses} spends, ${counts.requests} approved requests, ${counts.households} households (${counts.guests} guests), ${counts.gifts} registry gifts (${counts.funded} funded)`,
    `${COUPLE.juniper.email}  owner (partner)  (TOTP)`,
    `${COUPLE.rowan.email}  owner (partner)  (TOTP)`,
    `${COUPLE.maple.email}  member (helper: sees the budget)`,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = await seedCouple();
  console.log(['Seeded the Knotwork couple (synthetic). Sign in at /demo with DEMO_MODE=1.', ...lines].join('\n'));
  await db.$disconnect();
}
