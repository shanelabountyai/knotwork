// public: the RSVP token is the credential; same-origin form posts only; rate limited per address with the RSVP pages
import { NextResponse } from 'next/server';
import { clientIp } from '@/core/http';
import { stopFromLink } from '@/lib/knotwork/guests/public';
import { fromThisSite } from '@/lib/knotwork/guests/same-site';

// The household stops its reminders (Phase 5). No fields: the token names the household. The same 404 for every link
// that does not work, and the same answer whether or not reminders were already stopped (rule 3).
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!fromThisSite(req.headers)) return new NextResponse('Not found', { status: 404 });
  const result = await stopFromLink(token, clientIp(req.headers));
  if (result === 'limited') return new NextResponse('Too many requests', { status: 429 });
  if (!result) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(null, { status: 303, headers: { Location: `/r/${encodeURIComponent(token)}/stop?done=1`, 'Cache-Control': 'no-store' } });
}
