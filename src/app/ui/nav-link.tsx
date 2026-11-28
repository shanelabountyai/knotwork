'use client';
// The one client file of the design: links that mark themselves as the current page (aria-current="page"), which the
// stylesheet draws as the selected tab. `exact`: only this path, not the pages under it. On a phone a tab row
// scrolls sideways, so the current tab scrolls itself into view inside its row (never the page: block 'nearest').
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

const under = (path: string | null, href: string, exact?: boolean) => path !== null && (path === href || (!exact && path.startsWith(`${href}/`)));

/** Keeps a current tab in view inside its own row (the row scrolls; the page never does). */
function useInView(current: boolean) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const row = ref.current?.closest('ul');
    if (!current || !ref.current || !row || row.scrollWidth <= row.clientWidth) return;
    const a = ref.current;
    row.scrollLeft = Math.max(0, a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2);
  }, [current]);
  return ref;
}

export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: ReactNode }) {
  const current = under(usePathname(), href, exact);
  const ref = useInView(current);
  return <Link ref={ref} href={href} aria-current={current ? 'page' : undefined}>{children}</Link>;
}

// ---- the wedding's tabs (round 2, D-173): five top tabs, and the current one's pages as a second row ---------------

/** A page in a group. `exact`: only this path counts as this page. */
export type TabItem = { href: string; text: string; count?: number; exact?: boolean };
/** A top tab: its own page (`href`), the paths that belong to it (`match`), and its pages (the second row). */
export type TabGroup = { key: string; text: string; href: string; count?: number; match: { href: string; exact?: boolean }[]; items: TabItem[] };

/** How long a match is: the longest of a group's paths that the current path is on or under (0 = none). */
const depth = (path: string | null, list: { href: string; exact?: boolean }[]) => Math.max(0, ...list.filter((m) => under(path, m.href, m.exact)).map((m) => m.href.length));

/** The group the current path belongs to: the one with the longest matching path. */
export const currentGroup = (path: string | null, groups: TabGroup[]) => {
  let best: TabGroup | undefined;
  let len = 0;
  for (const g of groups) {
    const d = depth(path, g.match);
    if (d > len) [best, len] = [g, d];
  }
  return best;
};

/** The current page in a group's row: the item with the longest matching path. */
const currentItem = (path: string | null, items: TabItem[]) => {
  let best: TabItem | undefined;
  for (const x of items) if (under(path, x.href, x.exact) && (!best || x.href.length > best.href.length)) best = x;
  return best;
};

const Count = ({ n }: { n?: number }) => (n ? <> <span className="kw-count"><span className="sr-only">(</span>{n}<span className="sr-only">)</span></span></> : null);

function Tab({ href, current, children }: { href: string; current: 'page' | 'true' | undefined; children: ReactNode }) {
  const ref = useInView(current !== undefined);
  return <Link ref={ref} href={href} aria-current={current}>{children}</Link>;
}

/**
 * The wedding's navigation: one `<nav aria-label="Wedding">` with the five top tabs, then the current tab's pages as a
 * second row. The current top tab is `aria-current="page"` when you are on its own page and it has no second row,
 * otherwise `aria-current="true"` (the current section); the page you are on in the second row is `"page"`.
 */
export function WeddingTabs({ groups }: { groups: TabGroup[] }) {
  const path = usePathname();
  const group = currentGroup(path, groups);
  const rows = group && group.items.length > 0 ? group.items : null;
  const item = rows ? currentItem(path, rows) : undefined;
  const topCurrent = (g: TabGroup) => (g !== group ? undefined : !rows || (!item && under(path, g.href, true)) ? 'page' : 'true');
  return (
    <nav aria-label="Wedding" className="kw-tabs">
      <ul aria-label="Sections">
        {groups.map((g) => <li key={g.key}><Tab href={g.href} current={topCurrent(g)}>{g.text}<Count n={g.count} /></Tab></li>)}
      </ul>
      {rows && group && (
        <ul aria-label={`${group.text} pages`} className="kw-tabs-sub">
          {rows.map((x) => <li key={x.href}><Tab href={x.href} current={x === item ? 'page' : undefined}>{x.text}<Count n={x.count} /></Tab></li>)}
        </ul>
      )}
    </nav>
  );
}
