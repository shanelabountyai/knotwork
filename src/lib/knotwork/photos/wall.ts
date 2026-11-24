// What the live wall shows next (PRD P0-6: "newest first with rotation"). PURE, and imported by the wall's client
// component as well as its test.
//
// The feed is the wall-visible photos, newest first. A photo nobody has seen on this screen yet always goes first
// (the newest of them first), so a guest's upload appears within one slide. When there is nothing new, the wall
// rotates: it shows the photo it showed longest ago, which walks the whole feed in a steady cycle. A photo that has
// left the feed (taken down, hidden) is never shown again, whatever the screen remembers.

/** The id to show next, or null when the feed is empty. `shown` is every id this screen has shown, oldest first. */
export function nextOnWall(feed: readonly string[], shown: readonly string[]): string | null {
  if (feed.length === 0) return null;
  const lastShown = new Map<string, number>();
  shown.forEach((id, i) => lastShown.set(id, i));
  const fresh = feed.find((id) => !lastShown.has(id));
  if (fresh) return fresh;
  // Everything has been seen: the one shown longest ago. Ties cannot happen (one index per id).
  return feed.reduce((best, id) => (lastShown.get(id)! < lastShown.get(best)! ? id : best));
}

/** The first `n` slides from a standing start: what a wall shows if nothing changes. For the test and the page's first paint. */
export function sequence(feed: readonly string[], n: number, shown: readonly string[] = []): string[] {
  const seen = [...shown];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = nextOnWall(feed, seen);
    if (id === null) break;
    out.push(id);
    seen.push(id);
  }
  return out;
}

/** Keeps the screen's memory bounded: only ids still in the feed matter, and only the last time each was shown. */
export function remember(shown: readonly string[], id: string, feed: readonly string[]): string[] {
  const live = new Set(feed);
  return [...shown.filter((x) => x !== id && live.has(x)), id];
}

export type WallPhoto = { id: string; src: string; by: string; caption: string };
export const WALL_POLL_MS = 5_000;
export const WALL_SLIDE_MS = 6_000;
