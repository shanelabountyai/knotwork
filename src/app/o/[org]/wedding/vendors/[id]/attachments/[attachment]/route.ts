import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { allows } from '@/lib/knotwork/access';
import { loadWho } from '@/lib/knotwork/context';
import { attachmentFile } from '@/lib/knotwork/secrecy/views';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One contract attachment's bytes, to someone who can see vendors. The type sent is the stored one (the pipeline
// writes only JPEG) and the browser is told not to guess. Another workspace's attachment is a 404, and so is one on a
// vendor that is private to the other partner (P1-1).
export async function GET(_req: Request, { params }: { params: Promise<{ org: string; id: string; attachment: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id, attachment } = await params;
  if (!UUID.test(id) || !UUID.test(attachment)) notFound();
  const found = await withOrg(ctx, async (tx) => {
    if (!allows(await loadWho(tx, ctx), 'vendors.view')) notFound();
    return (await attachmentFile(tx, ctx, ctx, id, attachment)) ?? notFound();
  });
  return new Response(found.bytes as BodyInit, {
    headers: { 'Content-Type': found.mime, 'Content-Length': String(found.bytes.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="attachment-${attachment.slice(0, 8)}.jpg"` },
  });
}
