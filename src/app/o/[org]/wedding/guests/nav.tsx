import { NavLink } from '@/app/ui/nav-link';

export function GuestNav({ slug }: { slug: string }) {
  const base = `/o/${slug}/wedding/guests`;
  const items: [string, string, boolean?][] = [[base, 'Households', true], [`${base}/waves`, 'Invitations and cap'], [`${base}/chase`, 'Chasing'], [`${base}/music`, 'Music'], [`${base}/import`, 'Import']];
  return (
    <nav aria-label="Guest list" className="kw-subtabs">
      <ul>{items.map(([href, text, exact]) => <li key={href}><NavLink href={href} exact={exact}>{text}</NavLink></li>)}</ul>
    </nav>
  );
}
