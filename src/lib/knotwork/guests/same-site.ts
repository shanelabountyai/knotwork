// Shared by the two form-post routes on a guest's link: /r/[token]/respond and /r/[token]/gifts/contribute.
import { isSameOrigin } from '@/core/http';

/**
 * A guest's pages (/r/[token] and /r/[token]/gifts) are served with Referrer-Policy: no-referrer (the token is in
 * the URL), and under that policy a browser
 * sends `Origin: null` even on a same-origin form post, so the template's isSameOrigin alone refuses every real reply.
 * Sec-Fetch-Site still tells the truth where it exists. So: a browser that says the post is cross-site, or an Origin
 * that names another site, is refused; a missing or null Origin with no Sec-Fetch-Site (an older browser) is let in,
 * because the token is the credential and whoever holds it could post directly anyway (D-45).
 */
export function fromThisSite(h: Headers): boolean {
  const site = h.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = h.get('origin');
  return !origin || origin === 'null' || isSameOrigin(h);
}
