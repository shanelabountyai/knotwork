import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { isSameOrigin } from '@/core/http';
import { allows } from '@/lib/knotwork/access';
import { loadWho } from '@/lib/knotwork/context';
import { vendorVisible } from '@/lib/knotwork/secrecy/views';
import { receiveImage } from '@/lib/knotwork/uploads/read';
import { addAttachment } from '@/lib/knotwork/vendors/attachments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Adds a contract attachment to a vendor (D-39, D-65). A route handler, not a server action: a file is not a JSON
// input. Signed-in, same-origin, and only for someone who can edit vendors; another workspace's vendor is a 404.
// RULE 4: this route never reads the file. `receiveImage` (src/lib/knotwork/uploads) reads the body under the byte
// cap and returns a re-encoded, metadata-free image or a refusal code; only that processed image is stored.
// Only a code from a closed list goes back in the URL.
export async function POST(req: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!isSameOrigin(req.headers)) return new NextResponse('Forbidden', { status: 403 });
  if (!UUID.test(id)) notFound();
  const archived = await withOrg(ctx, async (tx) => {
    const who = await loadWho(tx, ctx);
    if (!allows({ ...who, archived: false }, 'vendors.edit')) notFound();
    if (!(await vendorVisible(tx, ctx, ctx.userId, id))) notFound(); // missing, another workspace's, or private to the other partner
    return who.archived;
  });
  const back = (query: string) => new NextResponse(null, { status: 303, headers: { Location: `/o/${ctx.slug}/wedding/vendors/${id}${query}`, 'Cache-Control': 'no-store' } });
  if (archived) return back('?e=archived#attachments'); // D-144: the vendor's documents are read-only in life-admin mode; the body is never read
  const got = await receiveImage(req, { field: 'file', text: ['label'] });
  if (!got.ok) return back(`?e=${got.code}#attachments`);
  const added = await withOrg(ctx, async (tx) => {
    if (!(await vendorVisible(tx, ctx, ctx.userId, id))) notFound();
    return addAttachment(tx, ctx, id, got.text.label ?? '', got.image);
  });
  return back(added.ok ? '?attached=1#attachments' : `?e=${added.code}#attachments`);
}
