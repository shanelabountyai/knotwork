import { NavLink } from '@/app/ui/nav-link';

export function PhotoNav({ slug, event }: { slug: string; event?: { id: string; name: string } }) {
  const base = `/o/${slug}/wedding/photos`;
  return (
    <nav aria-label="Photos" className="kw-subtabs">
      <ul>
        <li><NavLink href={base} exact>Photo events</NavLink></li>
        {event && (
          <>
            <li><NavLink href={`${base}/${event.id}`} exact>{event.name}</NavLink></li>
            <li><NavLink href={`${base}/${event.id}/moderate`}>Moderate</NavLink></li>
            <li><NavLink href={`${base}/${event.id}/album`}>Album</NavLink></li>
            <li><NavLink href={`${base}/${event.id}/wall`}>Wall</NavLink></li>
          </>
        )}
      </ul>
    </nav>
  );
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
