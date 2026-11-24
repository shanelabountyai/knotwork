import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { allows } from '@/lib/knotwork/access';
import { logChange } from '@/lib/knotwork/changelog';
import { loadWho } from '@/lib/knotwork/context';
import { albumZip } from '@/lib/knotwork/photos/store';
import { UUID } from '../../nav';

export const dynamic = 'force-dynamic';

// The full-gallery download (PRD P0-6): one zip of the album (the live photos not hidden from it), full size, with a
// text file of names and captions. Signed-in only. Each download is logged.
export async function GET(_req: Request, { params }: { params: Promise<{ org: string; event: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { event: id } = await params;
  if (!UUID.test(id)) notFound();
  const at = now();
  const { name, zip } = await withOrg(ctx, async (tx) => {
    if (!allows(await loadWho(tx, ctx), 'photos.view')) notFound();
    const event = (await tx.photoEvent.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, name: true } })) ?? notFound();
    const bytes = await albumZip(tx, ctx, id, { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate(), hour: at.getUTCHours(), minute: at.getUTCMinutes(), second: at.getUTCSeconds() });
    await logChange(tx, ctx, 'photoevent', 'downloaded', event.id, event.name, null, { bytes: bytes.length });
    return { name: event.name, zip: bytes };
  });
  const file = `${ctx.slug}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photos'}.zip`;
  return new Response(zip as BodyInit, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${file}"`, 'Content-Length': String(zip.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
