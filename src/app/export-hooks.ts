import { moduleExportTables } from '@/app/modules';
import type { ExportTable } from '@/core/tenancy/export';

// Clone-owned (v1.6.0), like org-hooks.ts: which tables a data export holds beyond the template's core ones
// (addendum §5). Add one entry per org-owned table, selecting only columns that are safe to hand over: never a
// sealed column, token hash or recovery code (INV-34 scans the output). Every query runs inside withOrg.
//   { name: 'Booking', rows: (tx, orgId) => tx.booking.findMany({ where: { orgId }, select: { id: true, startsAt: true } }) },
// Knotwork: all twenty org-owned tables. None of the Phase 1 thirteen holds a sealed secret, a token or a token hash;
// the two hash-like columns (ScheduleBaseline.fingerprint, VendorBrief.inputsHash) are 16 hex characters of a preview
// or a brief body, not credentials, and short enough that the INV-34 scan for 64-hex strings stays meaningful (D-15).
const whole = (name: string, rows: ExportTable['rows']): ExportTable => ({ name, rows });
export const exportTables: readonly ExportTable[] = [
  ...moduleExportTables,
  whole('Wedding', (tx, orgId) => tx.wedding.findMany({ where: { orgId } })),
  whole('Task', (tx, orgId) => tx.task.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('TaskDependency', (tx, orgId) => tx.taskDependency.findMany({ where: { orgId } })),
  whole('ScheduleBaseline', (tx, orgId) => tx.scheduleBaseline.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('BudgetCategory', (tx, orgId) => tx.budgetCategory.findMany({ where: { orgId } })),
  whole('Expense', (tx, orgId) => tx.expense.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('BudgetSnapshot', (tx, orgId) => tx.budgetSnapshot.findMany({ where: { orgId }, orderBy: { takenAt: 'asc' } })),
  whole('Vendor', (tx, orgId) => tx.vendor.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('VendorPayment', (tx, orgId) => tx.vendorPayment.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('VendorFlag', (tx, orgId) => tx.vendorFlag.findMany({ where: { orgId }, orderBy: { raisedAt: 'asc' } })),
  whole('VendorBrief', (tx, orgId) => tx.vendorBrief.findMany({ where: { orgId }, orderBy: { generatedAt: 'asc' } })),
  whole('ConsentRequest', (tx, orgId) => tx.consentRequest.findMany({ where: { orgId }, orderBy: { proposedAt: 'asc' } })),
  whole('HelperGrant', (tx, orgId) => tx.helperGrant.findMany({ where: { orgId } })),
  // Phase 2. Household is the one table with secrets: the RSVP token's hash and its sealed copy are never selected.
  whole('GuestPlan', (tx, orgId) => tx.guestPlan.findMany({ where: { orgId } })),
  whole('Household', (tx, orgId) => tx.household.findMany({ where: { orgId }, omit: { rsvpTokenHash: true, rsvpTokenSealed: true }, orderBy: { name: 'asc' } })),
  whole('Guest', (tx, orgId) => tx.guest.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('InviteWave', (tx, orgId) => tx.inviteWave.findMany({ where: { orgId }, orderBy: { number: 'asc' } })),
  whole('HeadcountDelta', (tx, orgId) => tx.headcountDelta.findMany({ where: { orgId }, orderBy: { at: 'asc' } })),
  whole('ChaseEvent', (tx, orgId) => tx.chaseEvent.findMany({ where: { orgId }, orderBy: { at: 'asc' } })),
  whole('DoNotPlay', (tx, orgId) => tx.doNotPlay.findMany({ where: { orgId }, orderBy: { title: 'asc' } })),
];

// An org-owned table left out on purpose, with the reason. INV-34 fails on any model with an orgId column that is in
// neither list, so a new table cannot silently drop out of every export.
export const exportSkipped: Readonly<Record<string, string>> = {};
