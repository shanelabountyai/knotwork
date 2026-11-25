// public: the RSVP token is the credential; same-origin form posts only; rate limited per address
import { NextResponse } from 'next/server';
import { clientIp } from '@/core/http';
import { fromThisSite } from '@/lib/knotwork/guests/same-site';
import { claimGift } from '@/lib/knotwork/gifts/public';

// P1-8: a household marks a store item as bought, or takes its own mark back. A plain form post, like a contribution,
// with the same refusals in the same order: another site's post, then the rate limit, then the token. Only a code from
// the closed list goes back in the URL: never a quantity, never anything the guest typed.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const back = (query: string) => new NextResponse(null, { status: 303, headers: { Location: `/r/${encodeURIComponent(token)}/gifts${query}`, 'Cache-Control': 'no-store' } });
  if (!fromThisSite(req.headers)) return new NextResponse('Not found', { status: 404 });
  const form = await req.formData();
  const one = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string).slice(0, 60) : '');
  const result = await claimGift(token, clientIp(req.headers), { linkId: one('link'), op: one('op'), quantity: one('quantity') });
  if (result === 'limited') return new NextResponse('Too many requests', { status: 429 });
  if (!result) return new NextResponse('Not found', { status: 404 });
  return back(result.ok ? `?done=${result.done}` : `?e=${result.code}`);
}
