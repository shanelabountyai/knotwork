// public: the RSVP token is the credential; same-origin form posts only; rate limited per address
import { NextResponse } from 'next/server';
import { clientIp } from '@/core/http';
import { problemCodeOf } from '@/lib/knotwork/guests/projection';
import { readRsvp, submitRsvp } from '@/lib/knotwork/guests/public';
import { fromThisSite } from '@/lib/knotwork/guests/same-site';

// A guest's reply (PRD P0-3). A plain form post, so it works with no script. The fields are named per guest id as the
// page rendered them; the store checks every id against that guest's own household (projection.checkRsvp).
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const back = (query: string) => new NextResponse(null, { status: 303, headers: { Location: `/r/${encodeURIComponent(token)}${query}`, 'Cache-Control': 'no-store' } });
  if (!fromThisSite(req.headers)) return new NextResponse('Not found', { status: 404 });
  const ip = clientIp(req.headers);
  const view = await readRsvp(token, ip);
  if (view === 'limited') return new NextResponse('Too many requests', { status: 429 });
  if (!view) return new NextResponse('Not found', { status: 404 });
  const form = await req.formData();
  const one = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string).slice(0, 300) : '');
  const many = (k: string) => form.getAll(k).filter((x): x is string => typeof x === 'string').slice(0, 20);
  const responses = view.guests.filter((g) => one(`attending:${g.id}`) !== '').map((g) => ({
    guestId: g.id, attending: one(`attending:${g.id}`) === 'yes', meal: one(`meal:${g.id}`), dietary: many(`dietary:${g.id}`), accessibility: many(`accessibility:${g.id}`), songRequest: one(`song:${g.id}`),
  }));
  const result = await submitRsvp(token, ip, { responses, plusOneName: one('plusOneName') });
  if (result === 'limited') return new NextResponse('Too many requests', { status: 429 });
  if (!result) return new NextResponse('Not found', { status: 404 });
  // Only a code from the closed list goes back in the URL, never the sentence and never a name (review S7).
  return back(result.ok ? '?done=1' : `?e=${problemCodeOf(result.message)}`);
}
