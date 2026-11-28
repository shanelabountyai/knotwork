// The design pass (docs/DESIGN_SYSTEM.md): the shared pieces say their state in words, the nav offers no dead end, the
// guest-facing pages use only presentational pieces, and the token pairs keep their contrast. No database.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuestHead, Keys, KEYS_LEGEND, keyWords, Status, TableWrap } from '@/app/ui/kw';
import { currentGroup } from '@/app/ui/nav-link';
import { WeddingNav, weddingTabs } from '@/app/o/[org]/wedding/bits';
import { paymentSummary } from '@/lib/knotwork/vendors/payments';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const tabs = (markup: string) => [...markup.matchAll(/<a [^>]*>([^<]+)/g)].map((m) => m[1]!.trim());

describe('the status pill and the keys say it in words', () => {
  it('a pill is the word with its family; the glyph is not in the text (CSS draws it)', () => {
    const out = html(Status({ k: 'late', children: 'late' }));
    expect(out).toBe('<span class="st" data-k="late">late</span>');
    expect(out).not.toMatch(/role=/); // not a live region: the pages' own notices stay the only role="status"
  });
  it('the keys draw two rings hidden from screen readers, and the words carry the state', () => {
    const one = html(Keys({ state: 'theirs', partner: 'Juniper Vale' }));
    expect(one).toContain('aria-hidden="true"');
    expect(one.match(/<i class="on"><\/i>/g)).toHaveLength(1);
    expect(one).toContain('Juniper Vale&#x27;s key is turned; yours is the second.');
    const solo = html(Keys({ state: 'solo' }));
    expect(solo).toContain('keys-rings solo');
    expect(html(Keys({ state: 'both' })).match(/<i class="on"><\/i>/g)).toHaveLength(2);
  });
  it('round 2: the keys own one fixed set of words, with the partner\'s name; the legend is one list (D-176)', () => {
    expect(keyWords('yours', 'Rowan Ashby')).toBe("Your key is turned; Rowan Ashby's is the second.");
    expect(keyWords('theirs')).toBe("your partner's key is turned; yours is the second.");
    expect(['none', 'yours', 'theirs', 'both', 'solo'].map((k) => keyWords(k as 'none', 'P', true))).toEqual(['no key turned', '1 of 2 keys', '1 of 2 keys', 'both keys', 'solo']);
    expect(KEYS_LEGEND.map((x) => x.state)).toEqual(['none', 'yours', 'both', 'solo']);
    // Home and Approvals render the same legend component and no keys words of their own.
    for (const f of ['src/app/o/[org]/page.tsx', 'src/app/o/[org]/wedding/approvals/page.tsx']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toContain('<KeysLegend />');
      expect(src, f).not.toMatch(/<Keys [^>]*[^/]>/); // never opened with children: Keys owns its words
    }
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
  const map = (g: ReturnType<typeof weddingTabs>) => Object.fromEntries(g.map((x) => [x.text, x.items.map((i) => i.text)]));
  it('round 2: five top tabs, every other page under one of them, the count in the link name (D-173)', () => {
    const out = html(createElement(WeddingNav, { slug: 's', who: partner, counts: { approvals: 2, flags: 1 } }));
    expect(tabs(out)).toEqual(['Home', 'Plan', 'Money', 'Guests', 'Approvals']);
    expect(out).toMatch(/Approvals <span class="kw-count"><span class="sr-only">\(<\/span>2<span class="sr-only">\)<\/span><\/span>/);
    const g = weddingTabs('s', { who: partner, counts: { approvals: 2, flags: 1 } });
    expect(map(g)).toEqual({
      Home: ['Progress', 'Activity', 'Helpers'],
      Plan: ['Schedule', 'Move the date', 'Contingency plans', 'Name change'],
      Money: ['Budget', 'Vendors', 'Funding', 'Re-confirmations'],
      Guests: ['Guest list', 'Seating', 'Gifts', 'Photos'],
      Approvals: [],
    });
    expect(g.find((x) => x.text === 'Money')!.items.find((i) => i.text === 'Re-confirmations')!.count).toBe(1);
  });
  it('every page the 15 old tabs reached is still reached, at the same URL (no route renamed or removed)', () => {
    const hrefs = weddingTabs('s', { who: partner }).flatMap((x) => [x.href, ...x.items.map((i) => i.href)]);
    for (const p of ['/o/s', 'dashboard', 'schedule', 'budget', 'funding', 'vendors', 'guests', 'gifts', 'photos', 'contingency', 'name-change', 'approvals', 'flags', 'activity', 'helpers']) {
      expect(hrefs, p).toContain(p === '/o/s' ? p : `/o/s/wedding/${p}`);
    }
  });
  it('a page belongs to the top tab whose path is the longest match, so the current tab is always marked', () => {
    const g = weddingTabs('s', { who: partner });
    const at = (p: string) => currentGroup(p, g)?.text;
    expect([at('/o/s'), at('/o/s/wedding/dashboard'), at('/o/s/wedding/schedule'), at('/o/s/wedding/date/insurance'), at('/o/s/wedding/vendors/x'), at('/o/s/wedding/flags'), at('/o/s/wedding/guests/seating'), at('/o/s/wedding/gifts/thank-yous'), at('/o/s/wedding/photos/e/album'), at('/o/s/wedding/approvals')])
      .toEqual(['Home', 'Home', 'Plan', 'Plan', 'Money', 'Money', 'Guests', 'Guests', 'Guests', 'Approvals']);
    const life = weddingTabs('s', { who: partner, life: true });
    expect(life.map((x) => x.text)).toEqual(['Home', 'Household', 'Gifts and photos', 'Archive', 'Approvals']);
    expect(currentGroup('/o/s/wedding/budget', life)?.text).toBe('Archive'); // an archived page sits under Archive
  });
  it('a helper sees only the tabs their grants open (the pages still decide; this is the nav)', () => {
    const out = tabs(html(createElement(WeddingNav, { slug: 's', who: funder })));
    expect(out).not.toContain('Approvals');
    expect(out).not.toContain('Guests');
    expect(out).toContain('Home');
    const g = weddingTabs('s', { who: funder });
    const pages = g.flatMap((x) => [x.href, ...x.items.map((i) => i.href)]);
    expect(pages).not.toContain('/o/s/wedding/helpers');
    expect(pages).not.toContain('/o/s/wedding/approvals');
    // A section left with one page is named after it (review): the funder's Plan tab is "Schedule", Money "Funding".
    expect(g.map((x) => x.text)).toEqual(['Home', 'Schedule', 'Funding']); // Plan and Money each left with one page
  });
  it('a badge on a second-row tab also shows on its top tab (review: the count stays visible on a phone)', () => {
    const g = weddingTabs('s', { who: partner, counts: { approvals: 0, flags: 3 } });
    expect(g.find((x) => x.key === 'money')!.count).toBe(3);
    expect(g.find((x) => x.key === 'approvals')!.count).toBeUndefined();
  });
  it('without a viewer (no `who`), nothing is hidden, as before the design pass', () => {
    const g = weddingTabs('s');
    expect(g).toHaveLength(5);
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(15); // 15 second-row pages, plus Home and Approvals as top tabs
  });
});

describe('round 2: money on the vendor row sums the existing payments, nothing more (D-175)', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  it('paid, balance and the next unpaid due day, derived from the wedding date', () => {
    const rows = [
      { amountCents: 50_000, dueDaysBefore: 180, paidOn: d('2027-01-02') },
      { amountCents: 120_050, dueDaysBefore: 30, paidOn: null },
      { amountCents: 30_000, dueDaysBefore: 60, paidOn: null },
    ];
    expect(paymentSummary(rows, '2027-10-09')).toEqual({ count: 3, paidCents: 50_000, balanceCents: 150_050, nextDue: { day: '2027-08-10', amountCents: 30_000 } });
  });
  it('two unpaid on the same day are both due then; all paid has no next due; none scheduled is empty', () => {
    expect(paymentSummary([{ amountCents: 100, dueDaysBefore: 7, paidOn: null }, { amountCents: 250, dueDaysBefore: 7, paidOn: null }], '2027-10-09').nextDue).toEqual({ day: '2027-10-02', amountCents: 350 });
    expect(paymentSummary([{ amountCents: 100, dueDaysBefore: 7, paidOn: d('2027-01-01') }], '2027-10-09')).toEqual({ count: 1, paidCents: 100, balanceCents: 0, nextDue: null });
    expect(paymentSummary([], '2027-10-09')).toEqual({ count: 0, paidCents: 0, balanceCents: 0, nextDue: null });
  });
  it('refuses a float, like usd()', () => {
    expect(() => paymentSummary([{ amountCents: 1.5, dueDaysBefore: 1, paidOn: null }], '2027-10-09')).toThrow('integer cents');
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
