// Renders a signed-in page to HTML in the test process, as whoever `as()` signed in last: the server component is
// awaited (its data loads exactly as in a request), then React renders the element tree to markup. A page that calls
// notFound() renders as NOT_FOUND. Used by the secrecy leak sweep (P1-1, ADR-001), which reads what each page would
// send to the other partner and to every helper.
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { AuthzError } from '@/core/authz/guards';
import { NavSignal } from '../helpers/next';

export const NOT_FOUND = '[[NOT FOUND]]';
export const FORBIDDEN = '[[FORBIDDEN]]';
type Page = (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;

export async function render(page: Page, params: Record<string, string>, searchParams: Record<string, string> = {}): Promise<string> {
  try {
    return renderToStaticMarkup(await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) }));
  } catch (e) {
    if (e instanceof NavSignal) return e.kind === 'notFound' ? NOT_FOUND : `[[REDIRECT ${e.to}]]`;
    if (e instanceof AuthzError) return FORBIDDEN; // the template's own pages refuse a role this way
    throw e;
  }
}

/** A route handler's GET, as text (or NOT_FOUND). */
export async function get(handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, params: Record<string, string>, url = 'http://localhost:8400/x'): Promise<{ status: number; text: string }> {
  try {
    const r = await handler(new Request(url), { params: Promise.resolve(params) });
    return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('latin1') };
  } catch (e) {
    if (e instanceof NavSignal && e.kind === 'notFound') return { status: 404, text: NOT_FOUND };
    if (e instanceof AuthzError) return { status: 403, text: FORBIDDEN };
    throw e;
  }
}

/**
 * Every signed-in page of the workspace that Knotwork owns (the home page and everything under /wedding), plus the
 * template's audit log, keyed by file. Found by glob, so a page added later is swept without being listed.
 */
const modules = import.meta.glob<{ default: Page }>(['/src/app/o/*/page.tsx', '/src/app/o/*/wedding/**/page.tsx', '/src/app/o/*/settings/audit/page.tsx']);
export const PAGES: Record<string, () => Promise<Page>> = Object.fromEntries(Object.entries(modules).map(([file, load]) => [file.slice(1), async () => (await load()).default]));
