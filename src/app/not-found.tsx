// The one "not found" page, for every route (Next's notFound()). It shows no data at all: the same fixed words for an
// unknown page, a wrong or ended guest link (rule 3: unknown, malformed, replaced and expired links are one 404) and a
// page the viewer may not open, so it says nothing about which one it was.
import { GuestHead } from '@/app/ui/kw';

export const metadata = { title: 'Not found', robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <main className="guest">
      <GuestHead title="This page isn’t here" />
      <p>The address may be wrong, or the link may have ended. If someone sent you a link, ask them for a new one.</p>
    </main>
  );
}
