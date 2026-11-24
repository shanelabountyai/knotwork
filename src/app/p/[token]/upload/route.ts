// public: the upload token is the credential; same-site form posts only; rate limited per device, address and event
import { NextResponse } from 'next/server';
import { env } from '@/core/env';
import { clientIp } from '@/core/http';
import { fromThisSite } from '@/lib/knotwork/guests/same-site';
import { DEVICE_COOKIE, DEVICE_COOKIE_DAYS, keepUpload, openUpload } from '@/lib/knotwork/photos/public';
import { discardBody, receiveImage } from '@/lib/knotwork/uploads/read';

// A guest's photo (PRD P0-6). A plain multipart form post, so it works with no script.
// RULE 4: this route never reads the file. The link, the device and the limits are settled first (openUpload), from
// the URL and the cookie alone; then `receiveImage` (src/lib/knotwork/uploads) reads the body under the byte cap and
// returns a re-encoded, metadata-free image or a refusal code; only that processed image is handed on to be stored.
// Only a code from a closed list goes back in the URL: never a file name, never anything the guest typed.
const cookieOf = (req: Request) => new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([\\w-]+)`).exec(req.headers.get('cookie') ?? '')?.[1] ?? null;

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!fromThisSite(req.headers)) return new NextResponse('Not found', { status: 404 });
  const opened = await openUpload(token, clientIp(req.headers), cookieOf(req));
  if (opened === 'limited') return new NextResponse('Too many requests', { status: 429 });
  if (!opened) return new NextResponse('Not found', { status: 404 });
  const back = (query: string, deviceToken: string | null = null) => {
    const res = new NextResponse(null, { status: 303, headers: { Location: `/p/${encodeURIComponent(token)}${query}`, 'Cache-Control': 'no-store' } });
    // The device: a random token only this browser holds (httpOnly), of which the database keeps the sha256.
    if (deviceToken) res.cookies.set(DEVICE_COOKIE, deviceToken, { httpOnly: true, sameSite: 'lax', secure: env.APP_URL.startsWith('https:'), path: '/p', maxAge: DEVICE_COOKIE_DAYS * 86_400 });
    return res;
  };
  if (!opened.ok) {
    await discardBody(req);
    return back(`?e=${opened.code}`);
  }
  const { ticket } = opened;
  const got = await receiveImage(req, { field: 'photo', text: ['name', 'caption'] });
  if (!got.ok) return back(`?e=${got.code}`, ticket.newDeviceToken);
  const kept = await keepUpload(ticket, { name: got.text.name ?? '', caption: got.text.caption ?? '' }, got.image);
  if (!kept) return new NextResponse('Not found', { status: 404 });
  return back(kept.ok ? `?done=${kept.done}` : `?e=${kept.code}`, ticket.newDeviceToken);
}
