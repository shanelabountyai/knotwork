'use client';
// The one client piece of the design: a link that marks itself as the current page (aria-current="page"), which the
// stylesheet draws as the selected tab. `exact`: only this path, not the pages under it. On a phone the tab row
// scrolls sideways, so the current tab scrolls itself into view inside its row (never the page: block 'nearest').
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: ReactNode }) {
  const path = usePathname();
  const current = path !== null && (path === href || (!exact && path.startsWith(`${href}/`)));
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const row = ref.current?.closest('ul');
    if (!current || !ref.current || !row || row.scrollWidth <= row.clientWidth) return;
    const a = ref.current;
    row.scrollLeft = Math.max(0, a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2);
  }, [current]);
  return <Link ref={ref} href={href} aria-current={current ? 'page' : undefined}>{children}</Link>;
}
