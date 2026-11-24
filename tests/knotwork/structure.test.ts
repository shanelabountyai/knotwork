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
  };

  it('finds the clone\'s twenty models', () => {
    expect(models.map((m) => m.name)).toHaveLength(20);
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
    expect(filesWith(/data:\s*\{[^}]*status:\s*'booked'/)).toEqual([EXECUTE]); // elsewhere 'booked' is only a read filter
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
