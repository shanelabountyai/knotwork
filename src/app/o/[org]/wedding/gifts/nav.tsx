import Link from 'next/link';

export function GiftNav({ slug }: { slug: string }) {
  const base = `/o/${slug}/wedding/gifts`;
  return (
    <nav aria-label="Gifts">
      <Link href={base}>Registry</Link> · <Link href={`${base}/thank-yous`}>Thank-yous</Link>
    </nav>
  );
}
