// The universal change log (PRD P0-2, bride review #4): who, what, when, before and after, on every Knotwork entity.
// It IS the template's append-only audit log (src/core/audit.ts, INV-19): one log, already exported, and a database
// trigger refuses any edit or delete. Actions are named `knotwork.<entity>.<verb>` (D-15). Call it in the same
// transaction as the write, so a change and its log line commit together or not at all.
//
// Never put a 64-hex string in `label` or a change: the data export scans for them (INV-34).
import { audit, auditEvents } from '@/core/audit';
import type { Tx } from '@/core/db/rls';
import type { Prisma } from '@/generated/prisma/client';
import { diff, type Plain } from './changelog-diff';

export const ENTITIES = ['wedding', 'task', 'baseline', 'category', 'expense', 'snapshot', 'vendor', 'payment', 'flag', 'brief', 'request', 'grant', 'household', 'guest', 'wave', 'guestplan', 'song', 'registry', 'gift', 'thankyou', 'photoevent', 'photo', 'photodevice', 'attachment'] as const;
export type Entity = (typeof ENTITIES)[number];
export const PREFIX = 'knotwork.';

/**
 * Appends one entry. `before`/`after` are whole rows or just the fields in play; only what differs is stored.
 * An update that changes nothing writes nothing and returns false.
 */
export async function logChange(tx: Tx, ctx: { orgId: string; userId: string | null }, entity: Entity, verb: string, id: string, label: string, before: Plain | null, after: Plain | null, extra: Plain = {}): Promise<boolean> {
  const d = diff(before, after);
  if (!d && verb === 'updated') return false;
  await audit(ctx, `${PREFIX}${entity}.${verb}`, { targetType: entity, targetId: id, data: { label, before: d?.before ?? null, after: d?.after ?? null, ...extra } as Prisma.InputJsonObject }, tx);
  return true;
}

/** The org's Knotwork entries, newest first. */
export const changeLog = (tx: Tx, orgId: string, take = 200) => auditEvents(tx, orgId, { action: PREFIX }, { take });
