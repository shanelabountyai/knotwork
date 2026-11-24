// public: the RSVP token is the credential; same-origin form posts only; rate limited per address
import { NextResponse } from 'next/server';
import { clientIp, isSameOrigin } from '@/core/http';
import { readRsvp, submitRsvp } from '@/lib/knotwork/guests/public';

// A guest's reply (PRD P0-3). A plain form post, so it works with no script. The fields are named per guest id as the
// page rendered them; the store checks every id against that guest's own household (projection.checkRsvp).
/**
 * The RSVP page is served with Referrer-Policy: no-referrer (the token is in the URL), and under that policy a browser
 * sends `Origin: null` even on a same-origin form post, so the template's isSameOrigin alone refuses every real reply.
 * Sec-Fetch-Site still tells the truth where it exists. So: a browser that says the post is cross-site, or an Origin
 * that names another site, is refused; a missing or null Origin with no Sec-Fetch-Site (an older browser) is let in,
 * because the token is the credential and whoever holds it could post directly anyway (D-45).
 */
function fromThisSite(h: Headers): boolean {
  const site = h.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = h.get('origin');
  return !origin || origin === 'null' || isSameOrigin(h);
}

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
  return back(result.ok ? '?done=1' : `?problem=${encodeURIComponent(result.message)}`);
}
