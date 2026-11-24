import Link from 'next/link';

export function PhotoNav({ slug, event }: { slug: string; event?: { id: string; name: string } }) {
  const base = `/o/${slug}/wedding/photos`;
  return (
    <nav aria-label="Photos">
      <Link href={base}>Photo events</Link>
      {event && (
        <>
          {' '}· <Link href={`${base}/${event.id}`}>{event.name}</Link> · <Link href={`${base}/${event.id}/moderate`}>Moderate</Link> · <Link href={`${base}/${event.id}/album`}>Album</Link> ·{' '}
          <Link href={`${base}/${event.id}/wall`}>Wall</Link>
        </>
      )}
    </nav>
  );
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
