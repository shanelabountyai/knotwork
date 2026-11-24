// public: the RSVP token is the credential; same-origin form posts only; rate limited per address
import { NextResponse } from 'next/server';
import { clientIp } from '@/core/http';
import { fromThisSite } from '@/lib/knotwork/guests/same-site';
import { contributeGift } from '@/lib/knotwork/gifts/public';

// A household's contribution toward a registry item (PRD P0-5, D-63). A plain form post, so it works with no script.
// The same refusals as the RSVP route, in the same order: another site's post, then the rate limit, then the token.
// Only a code from a closed list goes back in the URL: never an amount, never anything the guest typed.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const back = (query: string) => new NextResponse(null, { status: 303, headers: { Location: `/r/${encodeURIComponent(token)}/gifts${query}`, 'Cache-Control': 'no-store' } });
  if (!fromThisSite(req.headers)) return new NextResponse('Not found', { status: 404 });
  const form = await req.formData();
  const one = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string).slice(0, 60) : '');
  const result = await contributeGift(token, clientIp(req.headers), { itemId: one('item'), amount: one('amount') });
  if (result === 'limited') return new NextResponse('Too many requests', { status: 429 });
  if (!result) return new NextResponse('Not found', { status: 404 });
  return back(result.ok ? `?done=${result.done}` : `?e=${result.code}`);
}
