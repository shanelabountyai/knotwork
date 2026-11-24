import Link from 'next/link';

export function GuestNav({ slug }: { slug: string }) {
  const base = `/o/${slug}/wedding/guests`;
  return (
    <nav aria-label="Guest list">
      <Link href={base}>Households</Link> · <Link href={`${base}/waves`}>Invitations and cap</Link> · <Link href={`${base}/chase`}>Chasing</Link> ·{' '}
      <Link href={`${base}/music`}>Music</Link> · <Link href={`${base}/seating`}>Seating</Link> · <Link href={`${base}/import`}>Import</Link>
    </nav>
  );
}
