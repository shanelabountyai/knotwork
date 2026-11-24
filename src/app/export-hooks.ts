import { moduleExportTables } from '@/app/modules';
import type { ExportTable } from '@/core/tenancy/export';
import { exportRegistry } from '@/lib/knotwork/gifts/couple';
import { exportNameChangeArtifacts, exportNameChanges, exportNameChangeSteps } from '@/lib/knotwork/namechange/store';
import { exportBaselines, exportBudgetSnapshots, exportCategories, exportExpenses, exportTasks, exportVendorAttachments, exportVendorBriefs, exportVendorPayments, exportVendors } from '@/lib/knotwork/secrecy/export';

// Clone-owned (v1.6.0), like org-hooks.ts: which tables a data export holds beyond the template's core ones
// (addendum §5). Add one entry per org-owned table, selecting only columns that are safe to hand over: never a
// sealed column, token hash or recovery code (INV-34 scans the output). Every query runs inside withOrg.
//   { name: 'Booking', rows: (tx, orgId) => tx.booking.findMany({ where: { orgId }, select: { id: true, startsAt: true } }) },
// Knotwork: every org-owned table (twenty from Phases 1 and 2, three for gifting). None of the Phase 1 thirteen holds a sealed secret, a token or a token hash;
// the two hash-like columns (ScheduleBaseline.fingerprint, VendorBrief.inputsHash) are 16 hex characters of a preview
// or a brief body, not credentials, and short enough that the INV-34 scan for 64-hex strings stays meaningful (D-15).
const whole = (name: string, rows: ExportTable['rows']): ExportTable => ({ name, rows });
export const exportTables: readonly ExportTable[] = [
  ...moduleExportTables,
  whole('Wedding', (tx, orgId) => tx.wedding.findMany({ where: { orgId } })),
  // P1-1 (ADR-001): either partner may download the export, so it is built for nobody: an item private right now is
  // blanked (and what belongs to it); ids, amounts and dates stay (src/lib/knotwork/secrecy/export.ts).
  whole('Task', exportTasks),
  whole('TaskDependency', (tx, orgId) => tx.taskDependency.findMany({ where: { orgId } })),
  whole('ScheduleBaseline', exportBaselines),
  whole('BudgetCategory', exportCategories),
  whole('Expense', exportExpenses),
  whole('BudgetSnapshot', exportBudgetSnapshots),
  whole('Vendor', exportVendors),
  whole('VendorPayment', exportVendorPayments),
  whole('VendorFlag', (tx, orgId) => tx.vendorFlag.findMany({ where: { orgId }, orderBy: { raisedAt: 'asc' } })), // only on booked vendors, which are never private
  whole('VendorBrief', exportVendorBriefs),
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
  // Phase 3, gifting. The export is the couple's, so it holds what the couple may see: each item with its total and
  // its contributors' names (built by gifts/couple.ts), and the thank-yous. The ledger itself is skipped, below.
  whole('RegistryItem', (tx, orgId) => exportRegistry(tx, orgId)),
  whole('ThankYou', (tx, orgId) => tx.thankYou.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  // Phase 3, photos and contract attachments. Facts only: no image bytes (the gallery zip is the way out, D-64), no
  // upload-link hash or sealed copy, no device-cookie hash.
  whole('PhotoEvent', (tx, orgId) => tx.photoEvent.findMany({ where: { orgId }, omit: { uploadTokenHash: true, uploadTokenSealed: true }, orderBy: { createdAt: 'asc' } })),
  whole('PhotoDevice', (tx, orgId) => tx.photoDevice.findMany({ where: { orgId }, omit: { tokenHash: true }, orderBy: { createdAt: 'asc' } })),
  whole('Photo', (tx, orgId) => tx.photo.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('VendorAttachment', exportVendorAttachments),
  // Phase 4, P1-2: the funding tables, whole (amounts, days of fact, the linked helper's user id; no secret).
  whole('Funder', (tx, orgId) => tx.funder.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('FunderPledge', (tx, orgId) => tx.funderPledge.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('FunderReceipt', (tx, orgId) => tx.funderReceipt.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  whole('FunderAllocation', (tx, orgId) => tx.funderAllocation.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })),
  // Phase 4, P1-3 and P1-8: the gift log, the store items and households' claims, whole (who, what, days of fact; a
  // store item's price is the couple's own figure; no amount anyone gave, no secret).
  whole('GiftLog', (tx, orgId) => tx.giftLog.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })),
  whole('RegistryLink', (tx, orgId) => tx.registryLink.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })),
  whole('RegistryClaim', (tx, orgId) => tx.registryClaim.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })),
  // Phase 4, P1-4: name changes, built for nobody like ADR-001's tables (D-114): one that is private to its partner
  // keeps its ids, statuses and days of fact and loses which rules it follows and which steps and documents it names.
  whole('NameChange', exportNameChanges),
  whole('NameChangeStep', exportNameChangeSteps),
  whole('NameChangeArtifact', exportNameChangeArtifacts),
  // P1-6: contingency plans, their runs and checklists, whole (a tree of text, what was done, days of fact; no secret).
  whole('ContingencyPlan', (tx, orgId) => tx.contingencyPlan.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })),
  whole('ContingencyRun', (tx, orgId) => tx.contingencyRun.findMany({ where: { orgId }, orderBy: [{ executedAt: 'asc' }, { id: 'asc' }] })),
  whole('ContingencyItem', (tx, orgId) => tx.contingencyItem.findMany({ where: { orgId }, orderBy: [{ runId: 'asc' }, { position: 'asc' }] })),
];

// An org-owned table left out on purpose, with the reason. INV-34 fails on any model with an orgId column that is in
// neither list, so a new table cannot silently drop out of every export.
export const exportSkipped: Readonly<Record<string, string>> = {
  GiftEntry: 'the gift ledger holds what each household gave, which the couple never sees (PRD P0-5); RegistryItem carries each item\'s total and contributor names instead',
  PhotoBlob: 'image bytes (three renditions of every photo): far too large for a JSON export, and the gallery download (a zip of the album) is the way photos leave (D-64). Photo carries each photo\'s facts. VendorAttachment is exported the same way: its facts, without its bytes',
};
