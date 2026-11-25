// Contract attachments on a vendor (D-39, D-65): a photographed or scanned page, through the SAME upload pipeline as
// the photo wall. RULE 4: the only thing that can be stored is a `Processed` image (uploads/process.ts): re-encoded,
// metadata stripped, inspected clean. Images only; a PDF is refused by the pipeline with a sentence saying so.
import { inOrg } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { logChange } from '../changelog';
import type { Processed } from '../uploads/process';

type Ctx = { orgId: string; userId: string };
export const ATTACHMENTS_PER_VENDOR = 20;
export const LABEL_MAX = 80;
/** One line of plain text (D-61's rule), like everything else a person types that is shown back as a line. */
const ONE_LINE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;

export const ATTACHMENT_PROBLEM = {
  label: `Use one line of plain text for the label, ${LABEL_MAX} characters or fewer.`,
  many: `A vendor can hold ${ATTACHMENTS_PER_VENDOR} attachments. Remove one first.`,
} as const;
export type AttachmentProblem = keyof typeof ATTACHMENT_PROBLEM;

export async function addAttachment(tx: Tx, ctx: Ctx, vendorId: string, label: string, image: Processed): Promise<{ ok: true; id: string } | { ok: false; code: AttachmentProblem }> {
  const vendor = await tx.vendor.findFirstOrThrow({ where: { id: vendorId, ...inOrg(ctx) }, select: { id: true, name: true } });
  const text = label.trim() || 'Contract page';
  if (!ONE_LINE.test(text) || [...text].length > LABEL_MAX) return { ok: false, code: 'label' };
  if ((await tx.vendorAttachment.count({ where: { ...inOrg(ctx), vendorId } })) >= ATTACHMENTS_PER_VENDOR) return { ok: false, code: 'many' };
  const full = image.renditions.full;
  const row = await tx.vendorAttachment.create({ data: { orgId: ctx.orgId, vendorId, label: text, mime: image.mime, size: full.bytes.length, width: full.width, height: full.height, bytes: new Uint8Array(full.bytes), uploadedById: ctx.userId }, select: { id: true } });
  await logChange(tx, ctx, 'attachment', 'added', row.id, `${text} (${vendor.name})`, null, { vendor: vendor.name, label: text, width: full.width, height: full.height, bytes: full.bytes.length });
  return { ok: true, id: row.id };
}

/** A vendor's attachments, without their bytes. */
export const listAttachments = (tx: Tx, ctx: { orgId: string }, vendorId: string) =>
  tx.vendorAttachment.findMany({ where: { ...inOrg(ctx), vendorId }, select: { id: true, label: true, size: true, width: true, height: true, uploadedById: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

export const readAttachment = (tx: Tx, ctx: { orgId: string }, vendorId: string, id: string) =>
  tx.vendorAttachment.findFirst({ where: { id, vendorId, ...inOrg(ctx) }, select: { mime: true, bytes: true, label: true } });

export async function removeAttachment(tx: Tx, ctx: Ctx, id: string) {
  const a = await tx.vendorAttachment.findFirstOrThrow({ where: { id, ...inOrg(ctx) }, select: { label: true, vendor: { select: { name: true } } } });
  // Logged first: whether the entry may name the vendor is read from the row (P1-1), which is about to go.
  await logChange(tx, ctx, 'attachment', 'removed', id, `${a.label} (${a.vendor.name})`, { vendor: a.vendor.name, label: a.label }, null);
  await tx.vendorAttachment.delete({ where: { id } });
}
