// public: the vendor link token is the credential (matched by its sha256, INV-07; a sealed copy is kept so the couple can show it again, D-42); everything shown comes from vendors/projection.ts
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { clientIp } from '@/core/http';
import { readVendorLink } from '@/lib/knotwork/vendors/public';
import { GuestHead } from '@/app/ui/kw';

// RULE 3 (D-42): this page is outside the workspace, for one vendor. It renders the VendorLinkView and nothing else:
// the wedding's title, the vendor's name and its own brief, filtered by its category (counts, song titles and the
// do-not-play list; never a guest's name). Unknown, malformed, replaced, ended and expired links, and a dropped or
// private vendor, are the same 404. No-store and no-referrer headers come from next.config.ts on /v/:path*.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Vendor brief', robots: { index: false, follow: false } };

export default async function VendorBrief({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await readVendorLink(token, clientIp(await headers()));
  if (view === 'limited') return <main className="guest"><h1>Too many requests</h1><p>Wait a few minutes and try again.</p></main>;
  if (!view) notFound();
  return (
    <main className="brief">
      <GuestHead title={view.weddingTitle} />
      <p>The brief for <strong>{view.vendorName}</strong>, as it stands today. It is read-only; ask the couple about any change.</p>
      <pre aria-label="Vendor brief">{view.brief}</pre>
    </main>
  );
}
