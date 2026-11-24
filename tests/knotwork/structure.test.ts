import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './fixtures';

// CLAUDE.md rules 1 and 2 as scans, so a later change that breaks either fails here by name.
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const src = globSync('src/**/*.{ts,tsx}', { cwd: ROOT }).filter((f) => !f.startsWith('src/generated/')).sort();
const filesWith = (re: RegExp) => src.filter((f) => re.test(read(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))); // comments do not count

describe('rule 1: all deadlines derive from the anchor (no free-floating dates)', () => {
  const schema = read('prisma/schema/knotwork.prisma');
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, body: m[2]! }));
  const dateFields = models.flatMap((m) => [...m.body.matchAll(/^\s*(\w+)\s+DateTime\??\s+[^\n]*$/gm)].map((f) => `${m.name}.${f[1]}`));

  // Every date or timestamp column in the clone's schema, and why it is not a free-floating deadline.
  const ALLOWED: Record<string, string> = {
    'Wedding.date': 'THE anchor: the one stored deadline',
    'Wedding.createdAt': 'row timestamp', 'Wedding.updatedAt': 'row timestamp',
    'Wedding.pairedAt': 'a date of fact: when two partners were first seen (D-33)',
    'Task.completedOn': 'a date of fact: when it was finished', 'Task.createdAt': 'row timestamp',
    'ScheduleBaseline.fromDate': 'history: the anchor before a move', 'ScheduleBaseline.toDate': 'history: the anchor after a move', 'ScheduleBaseline.createdAt': 'row timestamp',
    'BudgetCategory.createdAt': 'row timestamp',
    'Expense.paidOn': 'a date of fact: when the money went out', 'Expense.createdAt': 'row timestamp',
    'BudgetSnapshot.takenAt': 'row timestamp',
    'Vendor.contractSignedOn': 'a date of fact: when both approved the contract', 'Vendor.createdAt': 'row timestamp',
    'VendorPayment.paidOn': 'a date of fact', 'VendorPayment.createdAt': 'row timestamp',
    'VendorFlag.raisedAt': 'row timestamp', 'VendorFlag.ackAt': 'a date of fact: when it was acknowledged',
    'VendorBrief.generatedAt': 'row timestamp',
    'ConsentRequest.proposedAt': 'row timestamp', 'ConsentRequest.expiresAt': 'when the request lapses: proposedAt + consentExpiryDays, not a plan deadline',
    'ConsentRequest.decidedAt': 'a date of fact', 'ConsentRequest.executedAt': 'a date of fact',
    'HelperGrant.createdAt': 'row timestamp',
    'GuestPlan.updatedAt': 'row timestamp',
    'Household.invitedOn': 'a date of fact: when the invitation was released (never guest-facing, rule 3)', 'Household.saveTheDateSentOn': 'a date of fact', 'Household.createdAt': 'row timestamp',
    'Guest.respondedAt': 'a date of fact', 'Guest.removedAt': 'a date of fact: when both approved the removal', 'Guest.createdAt': 'row timestamp',
    'InviteWave.releasedAt': 'a date of fact', 'HeadcountDelta.at': 'row timestamp', 'ChaseEvent.at': 'a date of fact: when the reminder went or the call was made',
    'DoNotPlay.createdAt': 'row timestamp',
    'RegistryItem.fundedOn': 'a date of fact: the day the pot reached its target', 'RegistryItem.closedOn': 'a date of fact: the day the registry was closed with the gift unfunded',
    'RegistryItem.createdAt': 'row timestamp', 'GiftEntry.createdAt': 'row timestamp: when the entry was written (the ledger is append-only)',
    'ThankYou.createdAt': 'row timestamp: when the thank-you became owed', 'ThankYou.acknowledgedOn': 'a date of fact: when a partner marked it as sent',
  };

  it('finds the clone\'s twenty-three models', () => {
    expect(models.map((m) => m.name)).toHaveLength(23); // twenty from Phases 1 and 2, three for gifting
  });
  it('every date column is on the list with its reason; a new one fails until someone decides what it is', () => {
    expect(dateFields.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
  it('Task has no date of its own except the day it was finished', () => {
    expect(dateFields.filter((f) => f.startsWith('Task.'))).toEqual(['Task.completedOn', 'Task.createdAt']);
    expect(models.find((m) => m.name === 'Task')!.body).toMatch(/leadDays\s+Int/);
    expect(models.find((m) => m.name === 'Task')!.body).toMatch(/bufferDays\s+Int/);
  });
  it('no column is named like a deadline', () => {
    const names = models.flatMap((m) => [...m.body.matchAll(/^\s*(\w+)\s+\w+/gm)].map((f) => f[1]!));
    expect(names.filter((n) => /^due(?!Days)|deadline|startBy|dueDate|dueOn/i.test(n))).toEqual([]);
  });
  it('a vendor payment is "N days before", never a date', () => {
    expect(models.find((m) => m.name === 'VendorPayment')!.body).toMatch(/dueDaysBefore\s+Int/);
  });
});

describe('rule 2: designated actions only through the consent module', () => {
  const EXECUTE = 'src/lib/knotwork/consent/execute.ts';

  it('only the executor (and the atomic move it calls) writes the wedding row after creation', () => {
    // The pairing latch (D-33) is not written by any file: the database sets it (D-56).
    expect(filesWith(/\.wedding\.(update|updateMany|upsert|delete|deleteMany)\(/)).toEqual([EXECUTE, 'src/lib/knotwork/schedule/store.ts']);
    expect(filesWith(/pairedAt:/)).toEqual([]);
    expect(read('src/lib/knotwork/schedule/store.ts').match(/\.wedding\.update\(/g)).toHaveLength(1); // inside commitMove
    expect(filesWith(/\bcommitMove\(/)).toEqual([EXECUTE, 'src/lib/knotwork/schedule/store.ts']); // defined in the store, called only by the executor
  });
  it('only the executor books a vendor or signs a contract', () => {
    expect(filesWith(/bookedRequestId:\s*(?!true)/)).toEqual([EXECUTE]);
    expect(filesWith(/contractRequestId:\s*(?!true)/)).toEqual([EXECUTE]);
    expect(filesWith(/data:\s*\{[^}]*contractSignedOn/)).toEqual([EXECUTE]); // elsewhere it is only read (the brief, the pages)
    expect(read('src/lib/knotwork/vendors/store.ts')).not.toMatch(/status:\s*'booked'/);
    // The two files besides the executor that say status: 'booked' only read it: syncRsvpTask in the schedule store, and
    // the on-site vendor count in the guest store. (Review 2026-11-24, M4: this list had been replaced by the narrower
    // `data: {…}` check below, which a write built in a variable would slip past. Both checks now hold.)
    const READS_BOOKED = ['src/lib/knotwork/guests/store.ts', 'src/lib/knotwork/schedule/store.ts'];
    expect(filesWith(/status:\s*'booked'/).filter((f) => !/vendors\/(scope|store)\.ts$/.test(f))).toEqual([EXECUTE, ...READS_BOOKED]);
    for (const f of READS_BOOKED) expect(read(f).match(/status:\s*'booked'/g)).toHaveLength(1);
    expect(read('src/lib/knotwork/guests/store.ts')).toMatch(/tx\.vendor\.count\(\{ where: \{ \.\.\.inOrg\(ctx\), status: 'booked', onSite: true \} \}\)/);
    expect(read('src/lib/knotwork/guests/store.ts')).not.toMatch(/\.vendor\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(filesWith(/data:\s*\{[^}]*status:\s*'booked'/)).toEqual([EXECUTE]);
  });
  it('only the executor removes a guest, and nothing ever deletes a guest or a household', () => {
    expect(filesWith(/data:\s*\{[^}]*removedAt/)).toEqual([EXECUTE]);
    expect(filesWith(/removedRequestId:\s*(?!true)/)).toEqual([EXECUTE]);
    expect(filesWith(/\.(guest|household)\.(delete|deleteMany)\(/)).toEqual([]);
    const sql = read('prisma/migrations/20261124000001_knotwork_phase2/migration.sql');
    for (const t of ['Guest_guard', 'Household_guard']) expect(sql).toContain(`CREATE TRIGGER "${t}"`);
  });
  it('only the budget store creates an expense, and it refuses one over the threshold without a request', () => {
    expect(filesWith(/\.expense\.(create|createMany|update|updateMany|upsert)\(/)).toEqual(['src/lib/knotwork/budget-store.ts']);
    expect(read('src/lib/knotwork/budget-store.ts')).toMatch(/spendNeedsConsent\(input\.amountCents, wedding\.spendThresholdCents\) && !requestId\) throw/);
  });
  it('only the consent store marks a request approved, and only it calls the executor', () => {
    expect(filesWith(/status:\s*'approved'/)).toEqual(['src/lib/knotwork/consent/store.ts']);
    expect(filesWith(/\bexecuteApproved\(/)).toEqual([EXECUTE, 'src/lib/knotwork/consent/store.ts']);
    expect(filesWith(/\.consentRequest\.(update|updateMany|delete|deleteMany|upsert)\(/)).toEqual(['src/lib/knotwork/consent/store.ts']);
  });
  it('the actions file never imports the executor or the atomic move', () => {
    const actions = read('src/app/o/[org]/wedding/actions.ts').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''); // comments do not count
    expect(actions).not.toMatch(/consent\/execute/);
    expect(actions).not.toMatch(/\bcommitMove\b/);
    expect(actions).not.toMatch(/\bcreateExpense\b(?!,| ,|\(tx, ctx, wedding, input, null\))/); // only the under-threshold call, with no request
  });
  it('the migration carries the database half: four guard triggers and the two-key check', () => {
    const sql = read('prisma/migrations/20261123000001_knotwork_phase1/migration.sql');
    for (const t of ['ConsentRequest_guard', 'Vendor_guard', 'Wedding_guard', 'Expense_guard']) expect(sql).toContain(`CREATE TRIGGER "${t}"`);
    const solo = read('prisma/migrations/20261124000000_knotwork_solo/migration.sql');
    for (const t of ['ConsentRequest_insert_guard', 'Wedding_paired_guard']) expect(solo).toContain(`CREATE TRIGGER "${t}"`);
    expect(sql).toContain('"deciderId" <> "proposerId"');
  });
});

describe('rules 3 and 4 have nothing to guard yet', () => {
  it('Phase 1 has no guest-facing route and accepts no upload', () => {
    const routes = globSync('src/app/**/{page,route}.{ts,tsx}', { cwd: ROOT });
    const publicKnotwork = routes.filter((f) => /wedding|rsvp|guest|wall|upload/i.test(f) && /^\/\/ public:/m.test(read(f)));
    expect(publicKnotwork).toEqual([]);
    expect(filesWith(/type="file"|formData\(\)\.get\([^)]*\) as File|multipart\/form-data/).filter((f) => f.includes('wedding') || f.includes('knotwork'))).toEqual([]);
  });
});

describe('P0-5 privacy: the couple\'s side never reads what one household gave', () => {
  const strip = (text: string) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''); // comments do not count
  const COUPLE_LOADER = 'src/lib/knotwork/gifts/couple.ts';
  const couplePages = globSync('src/app/o/**/*.{ts,tsx}', { cwd: ROOT }).sort();
  const giftPages = couplePages.filter((f) => f.includes('/wedding/gifts/'));
  // Everything signed-in people are served from, plus the data export: every file but the one loader.
  const coupleSide = [...couplePages, 'src/app/export-hooks.ts'];

  it('finds the couple\'s gift pages and actions', () => {
    expect(giftPages).toEqual(['actions.ts', 'nav.tsx', 'page.tsx', '[id]/page.tsx', 'thank-yous/page.tsx'].map((f) => `src/app/o/[org]/wedding/gifts/${f}`).sort());
  });
  it('no page, action or export hook on the couple\'s side names a ledger entry or its amount', () => {
    for (const f of [...giftPages, 'src/app/export-hooks.ts']) expect(strip(read(f)), f).not.toMatch(/amountCents/);
    for (const f of coupleSide) expect(strip(read(f)), f).not.toMatch(/\bgiftEntry\b|\bGiftEntry\w*\b(?!:)|gifts\/(public|projection)|\bnetByHousehold\b|\bcontributorsOf\b|\bpotCents\b/);
    // The export hook hands over what the couple\'s loader builds, and skips the ledger by name.
    expect(read('src/app/export-hooks.ts')).toMatch(/whole\('RegistryItem', \(tx, orgId\) => exportRegistry\(tx, orgId\)\)/);
    expect(read('src/app/export-hooks.ts')).toMatch(/^  GiftEntry: '/m);
  });
  it('the couple\'s pages reach the ledger only through the loader, and the store hands back no amount', () => {
    const imports = giftPages.flatMap((f) => [...read(f).matchAll(/from '@\/lib\/knotwork\/gifts\/([\w-]+)'/g)].map((m) => m[1]!));
    expect([...new Set(imports)].sort()).toEqual(['couple', 'ledger', 'store']);
    // From the ledger file the actions take two constants (the bounds), and from the store four writes.
    expect(read('src/app/o/[org]/wedding/gifts/actions.ts')).toMatch(/import \{ GIFT_MIN_CENTS, TARGET_MAX_CENTS \} from '@\/lib\/knotwork\/gifts\/ledger';/);
    expect(giftPages.filter((f) => /gifts\/(ledger|store)'/.test(read(f)))).toEqual(['src/app/o/[org]/wedding/gifts/actions.ts']);
    const store = strip(read('src/lib/knotwork/gifts/store.ts'));
    expect([...store.matchAll(/^export (?:async function|type|const) (\w+)/gm)].map((m) => m[1]!).sort()).toEqual(['Contributed', 'ItemInput', 'acknowledgeThankYou', 'addItem', 'closeRegistry', 'contribute', 'updateItem']);
    expect(store).toMatch(/export type Contributed = \{ ok: true; returned: boolean; funded: boolean \} \| \{ ok: false; code: RefusalCode \| 'not-here' \};/);
    expect(store).toMatch(/export async function closeRegistry\(tx: Tx, ctx: Ctx\): Promise<number>/);
  });
  it('the loader reads the ledger in exactly two shapes: a sum per item, and distinct (item, household) pairs with only a name', () => {
    const loader = strip(read(COUPLE_LOADER));
    expect(loader.match(/amountCents/g)).toHaveLength(2); // the aggregate, and reading its result
    expect(loader).toMatch(/tx\.giftEntry\.groupBy\(\{ by: \['itemId'\], where: \{ orgId \}, _sum: \{ amountCents: true \} \}\)/);
    expect(loader).toMatch(/s\._sum\.amountCents \?\? 0/);
    expect(loader).toMatch(/tx\.giftEntry\.findMany\(\{ where: \{ orgId \}, distinct: \['itemId', 'householdId'\], select: \{ itemId: true, household: \{ select: \{ name: true \} \} \} \}\)/);
    expect(loader.match(/\.giftEntry\./g)).toHaveLength(2);
    expect(loader).not.toMatch(/householdId'\][^)]*_sum|\$queryRaw|\$executeRaw|include:\s*\{[^}]*entries|entries:\s*(true|\{)/); // no per-household sum, no raw SQL, no entries pulled through an item
    expect(loader).not.toMatch(/gifts\/(public|projection|store)|\.\/(public|projection|store|ledger)'/);
  });
  it('no other file on the couple\'s side pulls entries through a relation', () => {
    for (const f of [...coupleSide, COUPLE_LOADER]) expect(strip(read(f)), f).not.toMatch(/registryItem\.[a-zA-Z]+\(\{[^;]*\bentries\b/);
    // The thank-you list is rows of (household, item, dates): the table has no amount column at all.
    const thankYou = /^model ThankYou \{([\s\S]*?)^\}/m.exec(read('prisma/schema/knotwork.prisma'))![1]!;
    expect(thankYou).not.toMatch(/Cents|amount/i);
  });
  it('only the ledger\'s engine and the guest\'s own page ever select an entry\'s amount (Expense.amountCents is the budget\'s, another table)', () => {
    expect(filesWith(/amountCents/).filter((f) => /gift|\/r\//.test(f))).toEqual(['src/lib/knotwork/gifts/couple.ts', 'src/lib/knotwork/gifts/ledger.ts', 'src/lib/knotwork/gifts/projection.ts', 'src/lib/knotwork/gifts/public.ts', 'src/lib/knotwork/gifts/store.ts']);
    expect(filesWith(/\.giftEntry\./)).toEqual(['src/lib/knotwork/gifts/couple.ts', 'src/lib/knotwork/gifts/public.ts', 'src/lib/knotwork/gifts/store.ts']);
    // A change-log line is written with logChange; none in the gift store is handed an amount.
    const store = strip(read('src/lib/knotwork/gifts/store.ts'));
    const logged = [...store.matchAll(/logChange\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(logged.length).toBeGreaterThanOrEqual(7);
    for (const call of logged.filter((x) => !/'registry', '(created|updated)'/.test(x))) expect(call).not.toMatch(/Cents|\.\.\.input|line\b|plan\b|refunds\[|\br\./);
    expect(store).toMatch(/logChange\(tx, ctx, 'gift', 'contributed', item\.id, `\$\{household\.name\} gave toward \$\{item\.title\}`, null, \{ household: household\.name, item: item\.title \}, \{ via: 'gift-link' \}\);/);
  });
  it('the ledger is append-only in the database, and the guest page has its own two guest-facing files', () => {
    const sql = read('prisma/migrations/20261125000000_knotwork_gifts/migration.sql');
    for (const t of ['GiftEntry_append_only', 'GiftEntry_guard']) expect(sql).toContain(`CREATE TRIGGER "${t}"`);
    for (const t of ['GiftEntry_pot_check', 'RegistryItem_pot_check']) expect(sql).toContain(`CREATE CONSTRAINT TRIGGER "${t}"`);
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "GiftEntry"');
    for (const c of ['RegistryItem_target_check', 'GiftEntry_sign_check']) expect(sql).toContain(`ADD CONSTRAINT "${c}"`);
    // Rule 3: the gift page and its route are built from gifts/public.ts, which is built from gifts/projection.ts.
    const guestFacing = globSync('src/app/r/**/*.{ts,tsx}', { cwd: ROOT }).sort();
    expect(guestFacing).toEqual(['src/app/r/[token]/gifts/contribute/route.ts', 'src/app/r/[token]/gifts/page.tsx', 'src/app/r/[token]/page.tsx', 'src/app/r/[token]/respond/route.ts']);
    for (const f of guestFacing) {
      expect(read(f), f).toMatch(/^\/\/ public: \S/m);
      expect(strip(read(f)), f).not.toMatch(/@\/core\/db|gifts\/(couple|store)|guests\/store|\btx\b|withOrg|asSystem/);
    }
    expect(strip(read('src/lib/knotwork/gifts/public.ts'))).not.toMatch(/asSystem|gifts\/couple|\.\/couple/);
    expect(strip(read('src/lib/knotwork/gifts/projection.ts'))).not.toMatch(/\b(list|wave\w*|priority|invitedOn|createdAt)\b/); // the words do not occur in the guest's shape at all
  });
});
