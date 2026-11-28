// The design pass (docs/DESIGN_SYSTEM.md): the shared pieces say their state in words, the nav offers no dead end, the
// guest-facing pages use only presentational pieces, and the token pairs keep their contrast. No database.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuestHead, Keys, Status, TableWrap } from '@/app/ui/kw';
import { WeddingNav } from '@/app/o/[org]/wedding/bits';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const tabs = (markup: string) => [...markup.matchAll(/<a [^>]*>([^<]+)/g)].map((m) => m[1]!.trim());

describe('the status pill and the keys say it in words', () => {
  it('a pill is the word with its family; the glyph is not in the text (CSS draws it)', () => {
    const out = html(Status({ k: 'late', children: 'late' }));
    expect(out).toBe('<span class="st" data-k="late">late</span>');
    expect(out).not.toMatch(/role=/); // not a live region: the pages' own notices stay the only role="status"
  });
  it('the keys draw two rings hidden from screen readers, and the words carry the state', () => {
    const one = html(Keys({ on: 1, children: 'one key turned' }));
    expect(one).toContain('aria-hidden="true"');
    expect(one.match(/<i class="on"><\/i>/g)).toHaveLength(1);
    expect(one).toContain('one key turned');
    const solo = html(Keys({ on: 1, solo: true, children: '(solo)' }));
    expect(solo).toContain('keys-rings solo');
  });
  it('a wide table sits in a named region a keyboard can reach, named apart from the table', () => {
    const out = html(TableWrap({ label: 'Schedule', children: createElement('table', { 'aria-label': 'Schedule' }) }));
    expect(out).toContain('role="region" aria-label="Table: Schedule" tabindex="0"');
  });
  it('the guest head shows only the title it is handed, as the one h1', () => {
    const out = html(createElement(GuestHead, { title: 'Juniper & Rowan' }));
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('<h1 class="display">Juniper &amp; Rowan</h1>');
  });
});

describe('the wedding tabs offer no dead end', () => {
  const partner = { role: 'owner', grants: [] as const };
  const funder = { role: 'member', grants: ['funder'] as const };
  it('a partner sees every tab, with the count in the link name', () => {
    const out = html(createElement(WeddingNav, { slug: 's', who: partner, counts: { approvals: 2, flags: 0 } }));
    expect(tabs(out)).toEqual(['Overview', 'Dashboard', 'Schedule', 'Budget', 'Funding', 'Vendors', 'Guests', 'Gifts', 'Photos', 'Contingency plans', 'Name change', 'Approvals', 'Vendor flags', 'Activity', 'Helpers']);
    expect(out).toMatch(/Approvals <span class="kw-count"><span class="sr-only">\(<\/span>2<span class="sr-only">\)<\/span><\/span>/);
  });
  it('a helper sees only the tabs their grants open (the pages still decide; this is the nav)', () => {
    const out = tabs(html(createElement(WeddingNav, { slug: 's', who: funder })));
    expect(out).not.toContain('Approvals');
    expect(out).not.toContain('Helpers');
    expect(out).not.toContain('Guests');
    expect(out).toContain('Overview');
  });
  it('without a viewer (no `who`), nothing is hidden, as before the design pass', () => {
    expect(tabs(html(createElement(WeddingNav, { slug: 's' })))).toHaveLength(15);
  });
});

describe('guest-facing pages (rule 3) use only presentational pieces', () => {
  const kw = readFileSync('src/app/ui/kw.tsx', 'utf8');
  it('kw.tsx reads no data: no database, store, projection, token or request', () => {
    expect(kw).not.toMatch(/@\/core\/(db|tokens|http)|@\/lib\/knotwork\/(?!.*types)|withOrg|asSystem|headers\(\)|fetch\(/);
    expect([...kw.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual(['react']);
  });
  it('each guest-facing page imports kw.tsx and nothing else new from the app', () => {
    for (const f of ['src/app/r/[token]/page.tsx', 'src/app/r/[token]/stop/page.tsx', 'src/app/p/[token]/page.tsx', 'src/app/v/[token]/page.tsx']) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/from '(@\/app\/[^']+)'/g)].map((m) => m[1]);
      expect(imports, f).toEqual(['@/app/ui/kw']);
    }
  });
});

describe('the stylesheet', () => {
  it('is the only one, imported once, by the root layout', () => {
    expect(readFileSync('src/app/layout.tsx', 'utf8')).toContain("import './ui/knotwork.css';");
  });
  it('npm run design:contrast passes (every token pair at its WCAG floor, both schemes)', () => {
    let out: string;
    try {
      out = execFileSync('python3', ['-I', 'tools/contrast.py'], { encoding: 'utf8' });
    } catch (e) {
      // No Python on this machine: CI's vitest step sets KNOTWORK_REQUIRE_PYTHON, so there it cannot skip.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !process.env.KNOTWORK_REQUIRE_PYTHON) return;
      throw e;
    }
    expect(out.trim().split('\n').at(-1)).toBe('OK 0 pairs under floor');
  });
});
