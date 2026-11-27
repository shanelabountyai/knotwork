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
  // WCAG 2.2.2: the slides move on their own, so the screen can pause them. A photo taken down still comes off at once.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); };

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
        if (gone || (fresh && !pausedRef.current)) advance();
      } catch {
        // the network blinked: keep showing what we have and ask again next time
      }
    };
    const polling = setInterval(poll, WALL_POLL_MS);
    const sliding = setInterval(() => { if (!pausedRef.current) advance(); }, WALL_SLIDE_MS);
    return () => {
      stopped = true;
      clearInterval(polling);
      clearInterval(sliding);
    };
  }, [advance, feedUrl]);

  const photo = feed.find((p) => p.id === current) ?? null;
  return (
    <main aria-label="Photo wall" data-theme="dark" className="kw-wall">
      {photo ? (
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element -- served by the signed-in image route at display size */}
          <img key={photo.id} src={photo.src} alt={photo.caption || `Photo from ${photo.by || 'a guest'}`} data-photo={photo.id} />
          {(photo.by || photo.caption) && (
            <figcaption>
              {photo.caption}{photo.caption && photo.by && ' — '}{photo.by}
            </figcaption>
          )}
        </figure>
      ) : (
        <p role="status">No photos yet. {qr ? 'Scan the code to add the first.' : ''}</p>
      )}
      <header>
        {title} · {eventName} · <span aria-label="Photos on the wall">{feed.length}</span> {feed.length === 1 ? 'photo' : 'photos'} · <a href={backUrl}>Leave the wall</a> <button type="button" onClick={togglePause}>{paused ? 'Play' : 'Pause'}</button>
      </header>
      {qr && (
        <aside aria-label="Add your photo">
          {/* eslint-disable-next-line @next/next/no-img-element -- an inline data: URL made on the server */}
          <img src={qr} alt="QR code: scan to add your photo" width={150} height={150} />
          <small>Scan to add your photo</small>
        </aside>
      )}
    </main>
  );
}
