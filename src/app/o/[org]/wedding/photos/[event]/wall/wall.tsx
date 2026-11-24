'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextOnWall, remember, WALL_POLL_MS, WALL_SLIDE_MS, type WallPhoto } from '@/lib/knotwork/photos/wall';

// The wall's screen. It holds no rule of its own: the feed comes from the server every few seconds, and what shows
// next is nextOnWall (a photo this screen has not shown yet first, the newest first; then the one shown longest ago).
export function Wall({ title, eventName, feedUrl, backUrl, initial, qr }: { title: string; eventName: string; feedUrl: string; backUrl: string; initial: WallPhoto[]; qr: string | null }) {
  const first = nextOnWall(initial.map((p) => p.id), []);
  const [feed, setFeed] = useState(initial);
  const [current, setCurrent] = useState<string | null>(first);
  const feedRef = useRef(initial);
  const shown = useRef<string[]>(first ? [first] : []);

  const advance = useCallback(() => {
    const ids = feedRef.current.map((p) => p.id);
    const next = nextOnWall(ids, shown.current);
    if (next) shown.current = remember(shown.current, next, ids);
    setCurrent(next);
  }, []);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(feedUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!res.ok || stopped) return;
        const next = ((await res.json()) as { photos: WallPhoto[] }).photos;
        const ids = next.map((p) => p.id);
        const fresh = ids.some((id) => !shown.current.includes(id));
        const gone = shown.current.length > 0 && !ids.includes(shown.current[shown.current.length - 1]!);
        feedRef.current = next;
        setFeed(next);
        // Something new goes up at once, and a photo that was taken down comes off at once.
        if (fresh || gone) advance();
      } catch {
        // the network blinked: keep showing what we have and ask again next time
      }
    };
    const polling = setInterval(poll, WALL_POLL_MS);
    const sliding = setInterval(advance, WALL_SLIDE_MS);
    return () => {
      stopped = true;
      clearInterval(polling);
      clearInterval(sliding);
    };
  }, [advance, feedUrl]);

  const photo = feed.find((p) => p.id === current) ?? null;
  return (
    <main aria-label="Photo wall" data-theme="dark" style={{ position: 'fixed', inset: 0, margin: 0, background: '#000', color: '#fff', overflow: 'hidden', zIndex: 10 }}>
      {photo ? (
        <figure style={{ margin: 0, width: '100%', height: '100%' }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- served by the signed-in image route at display size */}
          <img key={photo.id} src={photo.src} alt={photo.caption || `Photo from ${photo.by || 'a guest'}`} data-photo={photo.id} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          {(photo.by || photo.caption) && (
            <figcaption style={{ position: 'absolute', left: '2rem', bottom: '2rem', maxWidth: '60%', background: 'rgba(0,0,0,0.6)', padding: '0.6rem 1rem', borderRadius: '0.5rem', fontSize: '1.6rem' }}>
              {photo.caption}{photo.caption && photo.by && ' — '}{photo.by}
            </figcaption>
          )}
        </figure>
      ) : (
        <p role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: '2rem' }}>No photos yet. {qr ? 'Scan the code to add the first.' : ''}</p>
      )}
      <header style={{ position: 'absolute', left: '2rem', top: '1.2rem', fontSize: '1.2rem', opacity: 0.85 }}>
        {title} · {eventName} · <span aria-label="Photos on the wall">{feed.length}</span> {feed.length === 1 ? 'photo' : 'photos'} · <a href={backUrl} style={{ color: '#bbb' }}>Leave the wall</a>
      </header>
      {qr && (
        <aside aria-label="Add your photo" style={{ position: 'absolute', right: '1.5rem', bottom: '1.5rem', background: '#fff', color: '#000', padding: '0.6rem', borderRadius: '0.5rem', textAlign: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- an inline data: URL made on the server */}
          <img src={qr} alt="QR code: scan to add your photo" width={150} height={150} style={{ display: 'block' }} />
          <small>Scan to add your photo</small>
        </aside>
      )}
    </main>
  );
}
