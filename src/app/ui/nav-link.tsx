'use client';
// The one client piece of the design: a link that marks itself as the current page (aria-current="page"), which the
// stylesheet draws as the selected tab. `exact`: only this path, not the pages under it.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: ReactNode }) {
  const path = usePathname();
  const current = path !== null && (path === href || (!exact && path.startsWith(`${href}/`)));
  return <Link href={href} aria-current={current ? 'page' : undefined}>{children}</Link>;
}
