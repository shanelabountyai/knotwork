// public: the landing page
import Link from 'next/link';
import { demoEnabled } from '@/core/auth/demo';
import { GuestHead } from '@/app/ui/kw';

export const dynamic = 'force-dynamic'; // reads DEMO_MODE per request, never baked in at build

export default function Home() {
  return (
    <main className="guest">
      <GuestHead title="Knotwork">
        <p className="kw-when">Wedding planning for the two of you. Every deadline works back from the date, and the big decisions take both your keys.</p>
      </GuestHead>
      <p className="kw-row">
        <Link className="button" href="/login">Sign in</Link>
        {demoEnabled() && <Link className="button secondary" href="/demo">Demo accounts</Link>}
      </p>
      <p className="kw-guest-foot">A build-log project with synthetic data only.</p>
      <footer className="kw-guest-foot">
        <Link href="/legal/privacy">Privacy</Link> · <Link href="/legal/terms">Terms</Link>
      </footer>
    </main>
  );
}
