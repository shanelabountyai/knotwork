import { describe, expect, it } from 'vitest';
import { checkStoreUrl, LINK_REL, LINK_TARGET, parseQuantity, planClaim, QUANTITY_MAX, safeLink, URL_MAX, URL_PROBLEM } from '@/lib/knotwork/registry/links';

// P1-8: a store link is typed by a partner and rendered on every guest's page, so it is hostile input. Checked here
// without a database: https only, a named host, no credentials, nothing invisible, a length cap; stored canonical.
describe('the store URL check', () => {
  it('takes an ordinary https product link and stores it in canonical form', () => {
    expect(checkStoreUrl('https://www.example.com/skillet?size=10#reviews')).toEqual({ ok: true, href: 'https://www.example.com/skillet?size=10#reviews', host: 'www.example.com' });
    expect(checkStoreUrl('  HTTPS://Shop.Example.CO.uk  ')).toEqual({ ok: true, href: 'https://shop.example.co.uk/', host: 'shop.example.co.uk' });
    expect(checkStoreUrl('https://example.com:8443/a')).toMatchObject({ ok: true, host: 'example.com' });
    // An international name is kept in its punycode form, so a look-alike shows what it really is.
    expect(checkStoreUrl('https://bücher.example/x')).toEqual({ ok: true, href: 'https://xn--bcher-kva.example/x', host: 'xn--bcher-kva.example' });
    // A path may hold an @ (it is not in the authority) and percent-encoded text.
    expect(checkStoreUrl('https://example.com/u/@shop/a%20b')).toMatchObject({ ok: true });
  });

  it.each([
    ['', 'empty'], ['   ', 'empty'],
    ['javascript:alert(1)', 'scheme'], ['JavaScript:alert(document.cookie)', 'scheme'], ['javascript://example.com/%0aalert(1)', 'scheme'],
    ['data:text/html,<script>alert(1)</script>', 'scheme'], ['data:text/html;base64,PHNjcmlwdD4=', 'scheme'], ['vbscript:msgbox(1)', 'scheme'],
    ['http://www.example.com/skillet', 'scheme'], ['ftp://example.com/x', 'scheme'], ['file:///etc/passwd', 'scheme'], ['mailto:a@example.com', 'scheme'],
    ['//example.com/skillet', 'scheme'], ['www.example.com/skillet', 'scheme'], ['https:example.com', 'scheme'], ['https:/example.com', 'scheme'], ['/r/abc/gifts', 'scheme'],
    ['https://user:pass@example.com/', 'credentials'], ['https://user@example.com/', 'credentials'], ['https://@example.com/', 'credentials'], ['https://:@example.com/', 'credentials'],
    ['https://good.example@evil.example/', 'credentials'],
    ['https:///path', 'host'], ['https://', 'malformed'], ['https://localhost/x', 'host'], ['https://127.0.0.1/x', 'host'], ['https://[::1]/x', 'host'], ['https://192.168.1.1/', 'host'],
    ['https://example./x', 'host'], ['https://-bad-.example.com/', 'host'], ['https://exa_mple.com/', 'host'], ['https://0x7f.1/', 'host'],
    ['https://example.com/a b', 'malformed'], ['https://example.com/\tx', 'malformed'], ['https://example.com/x\ny', 'malformed'], ['https://exa\u0000mple.com/', 'malformed'],
    ['https://example.com\\@evil.example/', 'malformed'], ['https://example.com/\u202egnp.exe', 'malformed'], ['https://exam\u200bple.com/', 'malformed'], ['https://example.com/a\ufeffb', 'malformed'],
    // Around the address, spaces, a newline and a byte-order mark are trimmed, as a paste brings them.
    ['https://example.com/%zz', 'ok'], ['https://example.com/x\n', 'ok'], ['\ufeffhttps://example.com/', 'ok'],
    [`https://example.com/${'a'.repeat(URL_MAX)}`, 'long'], [`https://example.com/?q=${'é'.repeat(700)}`, 'long'],
    [`https://example.com/reset?t=${'ab12'.repeat(16)}`, 'token'],
  ] as const)('%j is %s', (raw, why) => {
    const c = checkStoreUrl(raw);
    if (why === 'ok') expect(c.ok, raw).toBe(true);
    else expect(c, raw).toEqual({ ok: false, why });
  });

  it('every refusal has its sentence, and none echoes what was typed', () => {
    for (const [why, text] of Object.entries(URL_PROBLEM)) {
      expect(text.length, why).toBeGreaterThan(10);
      expect(text).not.toMatch(/javascript|data:/i);
    }
  });

  it('a stored address is checked again on the way out; one that is not exactly canonical is no link', () => {
    expect(safeLink('https://www.example.com/skillet')).toEqual({ href: 'https://www.example.com/skillet', host: 'www.example.com' });
    for (const bad of ['javascript:alert(1)', 'http://example.com/', 'HTTPS://EXAMPLE.COM/', 'https://user@example.com/', '']) expect(safeLink(bad), bad).toBeNull();
    expect([LINK_REL, LINK_TARGET]).toEqual(['noopener noreferrer nofollow', '_blank']);
  });
});

describe('claims: bounded by how many the couple wants', () => {
  it('a claim fits in what remains, one per household', () => {
    expect(planClaim(3, 0, null, 2)).toEqual({ ok: true, claimedAfter: 2, remainingAfter: 1 });
    expect(planClaim(3, 2, null, 1)).toEqual({ ok: true, claimedAfter: 3, remainingAfter: 0 });
    expect(planClaim(3, 2, null, 2)).toEqual({ ok: false, code: 'too-many' });
    expect(planClaim(3, 3, null, 1)).toEqual({ ok: false, code: 'taken' });
    expect(planClaim(1, 5, null, 1)).toEqual({ ok: false, code: 'taken' }); // wanted lowered by hand below what exists: still nothing to take
    expect(planClaim(3, 1, 1, 1)).toEqual({ ok: false, code: 'already' });
    for (const bad of [0, -1, 1.5, QUANTITY_MAX + 1, Number.NaN]) expect(planClaim(200, 0, null, bad), String(bad)).toEqual({ ok: false, code: 'quantity' });
  });
  it('a quantity is a whole number as typed', () => {
    expect(['1', ' 2 ', '99', '100', '007'].map(parseQuantity)).toEqual([1, 2, 99, 100, 7]);
    for (const bad of ['', 'x', '1.0', '1e1', '-1', '2x', '1000', ' ']) expect(parseQuantity(bad), bad).toBeNull();
    expect([parseQuantity(3), parseQuantity(2.5)]).toEqual([3, null]);
  });
});
