import { beforeEach, describe, expect, it } from 'vitest';
import { addCategory, addExpense, addTask, addVendor, addVendorPayment, approveRequest, payVendorPayment, proposeContract } from '@/app/o/[org]/wedding/actions';
import { now } from '@/core/clock';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { as, db, makeWedding, ok, type Couple } from './db';
import { NOT_FOUND, PAGES, render } from './render';

// Phase 5: the date-move insurance information page (/wedding/date/insurance). The couple's own facts, through
// secrecy/views.ts (insuranceView); general questions; labelled as general information; no prices, no insurers, no
// statistics. The leak sweep (secrecy-db) covers it by glob; this file checks what it says.
const PAGE = 'src/app/o/[org]/wedding/date/insurance/page.tsx';
const today = () => todayIn('America/Chicago', now());
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
let c: Couple;
let date: string;
const show = async (to?: string) => render(await PAGES[PAGE]!(), { org: c.slug }, to ? { to } : {});

beforeEach(async () => {
  date = addDays(today(), 200);
  c = await makeWedding(date);
});

describe('the insurance information page', () => {
  it('is labelled general information, invents nothing, and names no insurer, price or statistic', async () => {
    const page = text(await show());
    expect(page).toContain('General information, not insurance or legal advice.');
    expect(page).toContain('Nothing here is a quote, an offer or a recommendation of any company.');
    expect(page).toContain('No contract is recorded as signed.');
    // With no facts recorded, the only money on the page is the couple's own zero totals; no percentage, no count of
    // people, no figure from anywhere else.
    expect(page.match(/\$[\d,.]+/g)).toEqual(['$0.00', '$0.00']);
    expect(page).not.toMatch(/%|per ?cent|\bmost couples\b|\baverage\b|\btypically costs?\b|\binsurer called\b|\bInc\.|\bLLC\b|\bLtd\b/i);
    for (const q of ['Is our reason for moving the date covered under the policy wording?', 'Can we move to the new date, and are you free that day?']) expect(page).toContain(q);
  });

  it('shows the couple\'s own facts: signed contracts, payments made and due (derived from the date), and what a move leaves late', async () => {
    await ok(addCategory(c.slug, { name: 'Venue', estimate: '9,000' }));
    await ok(addVendor(c.slug, { name: 'Cedar Hollow Barn', category: 'venue', contactName: '', email: '', phone: '' }));
    const barn = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Cedar Hollow Barn' } });
    await ok(proposeContract(c.slug, { id: barn.id, total: '8,000' }));
    await as(c.b);
    await ok(approveRequest(c.slug, { id: (await db.consentRequest.findFirstOrThrow({ where: { orgId: c.orgId, status: 'pending' } })).id }));
    await as(c.a);
    await ok(addVendorPayment(c.slug, { vendorId: barn.id, label: 'Deposit', amount: '400', dueDaysBefore: '180' }));
    await ok(addVendorPayment(c.slug, { vendorId: barn.id, label: 'Balance', amount: '7,600', dueDaysBefore: '30' }));
    const venue = await db.budgetCategory.findFirstOrThrow({ where: { orgId: c.orgId } });
    const deposit = await db.vendorPayment.findFirstOrThrow({ where: { orgId: c.orgId, label: 'Deposit' } });
    await ok(payVendorPayment(c.slug, { id: deposit.id, categoryId: venue.id, paidOn: addDays(today(), -2) }));
    await ok(addExpense(c.slug, { categoryId: venue.id, vendorId: barn.id, description: 'Site visit fee', amount: '50', paidOn: '' }));
    await ok(addTask(c.slug, { title: 'Order the arch', leadDays: '60', bufferDays: '190', assigneeId: '', dependsOn: [] }));
    const page = text(await show());
    expect(page).toMatch(/Cedar Hollow Barn \(venue\): signed .+, contract total \$8,000\.00/);
    expect(page).toContain('$400.00 on the vendors\' payment schedules');
    expect(page).toMatch(/Cedar Hollow Barn: Deposit, \$400\.00, paid /);
    expect(page).toContain('Other money recorded against a vendor: $50.00');
    expect(page).toContain('$7,600.00 still to pay');
    expect(page).toMatch(/Cedar Hollow Barn: Balance, \$7,600\.00, due /);
    expect(page).toContain('Pick a new date');
    // A move 30 days earlier leaves "Order the arch" (190 days of buffer) late.
    const moved = text(await show(addDays(date, -30)));
    expect(moved).toContain('You are looking at a move to');
    expect(moved).toContain('30 days earlier');
    expect(moved).toMatch(/Order the arch: (due|cannot be finished by) .+ \(new\)/);
    // The date page links here with the same date.
    const datePage = await render(await PAGES['src/app/o/[org]/wedding/date/page.tsx']!(), { org: c.slug }, { to: addDays(date, -30) });
    expect(datePage).toContain(`/o/${c.slug}/wedding/date/insurance?to=${addDays(date, -30)}`);
  });

  it('a private vendor\'s payment and a private task are masked for the other partner, and counted', async () => {
    await ok(addVendor(c.slug, { name: 'ZQX Engravers', category: 'other', contactName: '', email: '', phone: '', privacy: 'never' }));
    const v = await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } });
    await ok(addVendorPayment(c.slug, { vendorId: v.id, label: 'ZQX balance', amount: '200', dueDaysBefore: '30' }));
    await ok(addTask(c.slug, { title: 'ZQX Engrave the watch', leadDays: '60', bufferDays: '190', assigneeId: '', dependsOn: [], privacy: '0' }));
    expect(text(await show(addDays(date, -30)))).toContain('ZQX balance');
    await as(c.b);
    const page = text(await show(addDays(date, -30)));
    expect(page).not.toContain('ZQX');
    expect(page).toContain('$200.00 still to pay on the vendors\' payment schedules (including 1 private item, counted but not named)');
    expect(page).toContain('Private vendor');
    expect(page).toContain('Private task');
  });

  it('is for the partners: a helper is not shown it', async () => {
    await as(c.helper);
    expect(await show()).toBe(NOT_FOUND);
  });
});
