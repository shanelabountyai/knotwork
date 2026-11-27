import Link from 'next/link';
import { can } from '@/core/authz/permissions';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { Mark } from '@/app/ui/kw';

// Navigation only. Layouts do not re-run on every navigation, so each page calls requireOrg itself.
// The top bar (docs/DESIGN_SYSTEM.md): the mark, the workspace's name, and the account links, which are the template's
// settings pages. One <nav>: the wedding's own tabs are in each page (WeddingNav in wedding/bits.tsx).
export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  const base = `/o/${ctx.slug}`;
  return (
    <>
      <a className="skip" href="#content">Skip to content</a>
      <nav className="kw-top" aria-label="Workspace">
        <div className="kw-top-in">
          <Link className="kw-brand" href={base}><Mark />Knotwork</Link>
          <strong className="kw-org">{org.name}</strong>
          <div className="kw-account">
            <Link href={base}>Home</Link>
            <Link href={`${base}/wedding/schedule`}>Wedding</Link>
            <Link href={`${base}/settings/members`}>Members</Link>
            {can(ctx.role, 'audit.read') && <><Link href={`${base}/settings/audit`}>Audit log</Link><Link href={`${base}/settings/security`}>Security</Link></>}
            {ctx.role === 'owner' && <Link href={`${base}/settings/sso`}>SSO</Link>} {/* sso */}
            {can(ctx.role, 'apikeys.manage') && <Link href={`${base}/settings/apikeys`}>API keys</Link>} {/* apikeys */}
            {can(ctx.role, 'org.delete') && <Link href={`${base}/settings/danger`}>Export or delete</Link>}
            <Link href="/onboarding">Your orgs</Link>
            <Link href="/account/security">Account</Link>
          </div>
        </div>
      </nav>
      <div id="content" tabIndex={-1}>{children}</div>
    </>
  );
}
