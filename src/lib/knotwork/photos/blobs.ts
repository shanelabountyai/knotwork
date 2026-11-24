// Where photo bytes live (D-64): Postgres bytea, in PhotoBlob, apart from Photo so a list never loads them. This
// file is the whole seam: swap it for an object-store client at productionize and nothing else changes.
//
// RULE 4: the only thing that can be written is a `Processed` image, which only uploads/process.ts can make
// (re-encoded, inspected clean). There is no way to hand this file a request's raw bytes.
import type { Tx } from '@/core/db/rls';
import { RENDITION_KINDS, type RenditionKind } from '../uploads/caps';
import type { Processed } from '../uploads/process';

export async function writeBlobs(tx: Tx, orgId: string, photoId: string, image: Processed) {
  for (const kind of RENDITION_KINDS) {
    const r = image.renditions[kind];
    await tx.photoBlob.create({ data: { orgId, photoId, kind, bytes: new Uint8Array(r.bytes), size: r.bytes.length, width: r.width, height: r.height } });
  }
}

export async function readBlob(tx: Tx, orgId: string, photoId: string, kind: RenditionKind): Promise<Uint8Array | null> {
  return (await tx.photoBlob.findFirst({ where: { orgId, photoId, kind }, select: { bytes: true } }))?.bytes ?? null;
}

/** Deletes every rendition of the given photos. Returns how many blobs went. */
export async function deleteBlobs(tx: Tx, orgId: string, photoIds: string[]): Promise<number> {
  return (await tx.photoBlob.deleteMany({ where: { orgId, photoId: { in: photoIds } } })).count;
}
