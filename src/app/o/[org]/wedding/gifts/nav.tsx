import { NavLink } from '@/app/ui/nav-link';

export function GiftNav({ slug }: { slug: string }) {
  const base = `/o/${slug}/wedding/gifts`;
  return (
    <nav aria-label="Gifts" className="kw-subtabs">
      <ul>
        <li><NavLink href={base} exact>Registry</NavLink></li>
        <li><NavLink href={`${base}/thank-yous`}>Thank-yous</NavLink></li>
      </ul>
    </nav>
  );
}
