import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { exportTables } from '@/app/export-hooks';
import * as weddingActions from '@/app/o/[org]/wedding/actions';
import { GET as viewRoute } from '@/app/o/[org]/wedding/vendors/[id]/attachments/[attachment]/route';
import { POST as attachRoute } from '@/app/o/[org]/wedding/vendors/[id]/attachments/route';
import { removeVendorAttachment } from '@/app/o/[org]/wedding/vendors/actions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { UPLOAD_PROBLEM } from '@/lib/knotwork/uploads/caps';
import { ATTACHMENT_PROBLEM, ATTACHMENTS_PER_VENDOR, listAttachments } from '@/lib/knotwork/vendors/attachments';
import { jar } from '../helpers/next';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';
import { answer, caseBytes, expectClean, fixture, flat, manifest, multipart } from './uploads';

// Contract attachments on a vendor (D-39, D-65): the SAME upload pipeline as the photo wall, behind a signed-in route.
// Images only; a PDF is refused with a sentence that says so.
let c: Couple;
let vendorId: string;
const HOST = 'localhost:8400';
const sameSite = { origin: `http://${HOST}`, host: HOST };

async function attach(bytes: Uint8Array | null, o: { label?: string; vendor?: string; org?: string; headers?: Record<string, string>; fileName?: string; fileType?: string } = {}) {
  const org = o.org ?? c.slug;
  const id = o.vendor ?? vendorId;
  const req = multipart(`http://${HOST}/o/${org}/wedding/vendors/${id}/attachments`, 'file', bytes, { label: o.label ?? '' }, o.headers ?? sameSite, o.fileName ?? 'scan.jpg', o.fileType ?? 'image/jpeg');
  const r = await outcome(attachRoute(req, { params: Promise.resolve({ org, id }) }));
  return r.result ? answer(r.result as Response) : r;
}
const view = (attachment: string, o: { vendor?: string; org?: string } = {}) =>
  outcome(viewRoute(new Request(`http://${HOST}/x`), { params: Promise.resolve({ org: o.org ?? c.slug, id: o.vendor ?? vendorId, attachment }) }));
const rows = (orgId = c.orgId) => db.vendorAttachment.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const page = (query: string) => `/o/${c.slug}/wedding/vendors/${vendorId}${query}#attachments`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  c = await makeWedding(addDays(todayIn('America/Chicago', now()), 200));
  await ok(weddingActions.addVendor(c.slug, { name: 'Fennel & Fig Catering', category: 'caterer', contactName: '', email: '', phone: '' }));
  vendorId = (await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId } })).id;
});

describe('attaching a contract page', () => {
  it('a photographed page with EXIF, GPS, XMP, an ICC profile and a comment is stored as one clean JPEG, and logged', async () => {
    const raw = fixture('phone-gps.jpg');
    const sent = await attach(raw, { label: '  Contract, page 1 ', fileName: 'IMG_0042.JPG' });
    expect(sent).toMatchObject({ status: 303, location: page('?attached=1') });
    const [a] = await rows();
    expect(a).toMatchObject({ vendorId, label: 'Contract, page 1', mime: 'image/jpeg', width: 640, height: 480, uploadedById: c.a });
    expect(a!.size).toBe(a!.bytes.length);
    await expectClean(a!.bytes);
    expect(Buffer.from(a!.bytes).equals(raw)).toBe(false);
    const everything = await snapshot();
    for (const leak of ['Example Lane', 'Synthetic Guest', 'IMG_0042']) {
      expect(everything).not.toContain(leak);
      expect(everything).not.toContain(Buffer.from(leak, 'latin1').toString('hex'));
    }
    expect((await log(c.orgId)).at(-1)).toMatchObject({ action: 'knotwork.attachment.added', actorUserId: c.a, targetId: a!.id, data: { label: 'Contract, page 1 (Fennel & Fig Catering)', after: { vendor: 'Fennel & Fig Catering', label: 'Contract, page 1', width: 640, height: 480 } } });
    // With no label it is called "Contract page".
    await attach(fixture('alpha.png'));
    expect((await rows()).map((x) => x.label)).toEqual(['Contract, page 1', 'Contract page']);
  });
  it('a large scan is brought down to 4096 on its long side', async () => {
    await attach(fixture('big.jpg'), { label: 'Big scan' });
    const [a] = await rows();
    expect([a!.width, a!.height]).toEqual([4096, 2458]);
    await expectClean(a!.bytes);
  });
  it('a PDF is refused with the sentence that says PDFs are not accepted yet (D-65); nothing is stored', async () => {
    const before = await snapshot();
    expect(await attach(fixture('contract.pdf'), { fileName: 'contract.pdf', fileType: 'application/pdf' })).toMatchObject({ status: 303, location: page('?e=pdf') });
    expect(UPLOAD_PROBLEM.pdf).toBe('That file is a PDF. PDFs are not accepted yet: upload a photo or a scan of each page as a JPEG, PNG or WebP image.');
    // Calling it an image changes nothing: the bytes decide.
    expect(await attach(fixture('contract.pdf'), { fileName: 'contract.jpg', fileType: 'image/jpeg' })).toMatchObject({ location: page('?e=pdf') });
    expect(await snapshot()).toBe(before);
  });
  it.each(manifest().cases.filter((x) => x.expect.result !== 'ok').map((x) => [x.file ?? 'oversize (synthesized)', x] as const))('%s is refused with its code and nothing is stored', async (_, fx) => {
    const before = await snapshot();
    expect(await attach(caseBytes(fx))).toMatchObject({ status: 303, location: page(`?e=${fx.expect.result}`) });
    expect(await snapshot()).toBe(before);
  });
  it('a label must be one plain line of 80 characters or fewer, and a vendor holds twenty attachments', async () => {
    const picture = await flat(1, 2, 3);
    const before = await snapshot();
    expect(await attach(picture, { label: 'two\nlines' })).toMatchObject({ location: page('?e=label') });
    expect(await attach(picture, { label: 'x'.repeat(81) })).toMatchObject({ location: page('?e=label') });
    expect(await attach(null, { label: 'no file' })).toMatchObject({ location: page('?e=empty') });
    expect(await snapshot()).toBe(before);
    for (let i = 0; i < ATTACHMENTS_PER_VENDOR; i++) expect(await attach(picture, { label: `Page ${i + 1}` })).toMatchObject({ location: page('?attached=1') });
    expect(await attach(picture, { label: 'One too many' })).toMatchObject({ location: page('?e=many') });
    expect(await rows()).toHaveLength(ATTACHMENTS_PER_VENDOR);
    expect(ATTACHMENT_PROBLEM.many).toMatch(/20 attachments/);
  });
});

describe('who may attach, view and remove', () => {
  it('not signed in, another site, a helper without the vendor permission, and another workspace are all turned away before the file is read', async () => {
    const picture = await flat(9, 9, 9);
    const before = await snapshot();
    expect(await attach(picture, { headers: { origin: 'https://evil.example', host: HOST } })).toMatchObject({ status: 403 });
    expect(await attach(picture, { headers: { host: HOST } })).toMatchObject({ status: 403 }); // no Origin and no Sec-Fetch-Site
    expect(await attach(picture, { vendor: '00000000-0000-4000-8000-000000000000' })).toEqual({ nav: 'notFound' });
    expect(await attach(picture, { vendor: 'not-a-uuid' })).toEqual({ nav: 'notFound' });
    await as(c.helper);
    expect(await attach(picture)).toEqual({ nav: 'notFound' });
    jar.clear();
    expect(await attach(picture)).toMatchObject({ nav: 'redirect' }); // to sign in
    expect(await snapshot()).toBe(before);
    await as(c.a);
    await ok(weddingActions.grantHelper(c.slug, { userId: c.helper, scope: 'vendors_view' }));
    const granted = await snapshot();
    await as(c.helper);
    expect(await attach(picture)).toEqual({ nav: 'notFound' }); // seeing vendors is not editing them
    expect(await snapshot()).toBe(granted);
    expect(await rows()).toEqual([]);
    // With the edit permission, a helper can.
    await as(c.a);
    await ok(weddingActions.grantHelper(c.slug, { userId: c.helper, scope: 'vendors_edit' }));
    await as(c.helper);
    expect(await attach(picture, { label: 'From the helper' })).toMatchObject({ location: page('?attached=1') });
    expect((await rows())[0]).toMatchObject({ uploadedById: c.helper });
  });
  it('the view route sends the stored bytes as image/jpeg, tells the browser not to sniff, and stores nothing in a cache', async () => {
    await attach(fixture('phone-gps.jpg'), { label: 'Page 1' });
    const [a] = await rows();
    const res = (await view(a!.id)).result as Response;
    expect([res.status, res.headers.get('content-type'), res.headers.get('x-content-type-options'), res.headers.get('cache-control')]).toEqual([200, 'image/jpeg', 'nosniff', 'private, no-store']);
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(a!.bytes));
    // A helper who can see vendors can look; one who cannot gets a 404, like an attachment that does not exist.
    await as(c.helper);
    expect(await view(a!.id)).toEqual({ nav: 'notFound' });
    await as(c.a);
    await ok(weddingActions.grantHelper(c.slug, { userId: c.helper, scope: 'vendors_view' }));
    await as(c.helper);
    expect(((await view(a!.id)).result as Response).status).toBe(200);
    await refused(removeVendorAttachment(c.slug, { id: a!.id }), /You do not have access to that/);
    expect(await view('00000000-0000-4000-8000-000000000000')).toEqual({ nav: 'notFound' });
    expect(await view('nope')).toEqual({ nav: 'notFound' });
  });
  it('removing is logged with what was removed, and the list never carries bytes', async () => {
    await attach(await flat(5, 5, 5), { label: 'Page 1' });
    await attach(await flat(6, 6, 6), { label: 'Page 2' });
    const listed = await withOrg({ orgId: c.orgId }, (tx) => listAttachments(tx, { orgId: c.orgId }, vendorId));
    expect(listed.map((a) => Object.keys(a).sort())).toEqual([['createdAt', 'height', 'id', 'label', 'size', 'uploadedById', 'width'], ['createdAt', 'height', 'id', 'label', 'size', 'uploadedById', 'width']]);
    await as(c.b);
    expect(await ok(removeVendorAttachment(c.slug, { id: listed[0]!.id }))).toBe(`/o/${c.slug}/wedding/vendors/${vendorId}`);
    expect((await rows()).map((a) => a.label)).toEqual(['Page 2']);
    expect((await log(c.orgId)).at(-1)).toMatchObject({ action: 'knotwork.attachment.removed', actorUserId: c.b, targetId: listed[0]!.id, data: { label: 'Page 1 (Fennel & Fig Catering)', before: { label: 'Page 1' }, after: null } });
    expect(await view(listed[0]!.id)).toEqual({ nav: 'notFound' });
    // The data export has the attachment's facts and not its bytes.
    const exported = await withOrg({ orgId: c.orgId }, (tx) => exportTables.find((t) => t.name === 'VendorAttachment')!.rows(tx, c.orgId));
    expect(exported).toEqual([expect.objectContaining({ label: 'Page 2', mime: 'image/jpeg' })]);
    expect(Object.keys(exported[0]!)).not.toContain('bytes');
  });
  it('another workspace\'s vendor and attachment are not found, by route and by action, and the database refuses the cross', async () => {
    await attach(await flat(7, 7, 7), { label: 'Ours' });
    const [mine] = await rows();
    const other = await makeOrg('sage-and-wren');
    const sage = (await addMember(other.id, 'owner', 'sage@example.test')).id;
    await as(sage);
    await ok(weddingActions.createWedding(other.slug, { title: 'Sage & Wren', date: addDays(todayIn('America/Chicago', now()), 200), timeZone: 'America/Chicago' }));
    await ok(weddingActions.addVendor(other.slug, { name: 'Their Florist', category: 'florist', contactName: '', email: '', phone: '' }));
    const theirVendor = (await db.vendor.findFirstOrThrow({ where: { orgId: other.id } })).id;
    const before = await snapshot();
    const picture = await flat(8, 8, 8);
    // Sage reaches for Juniper and Rowan's vendor and attachment: through her own slug, and through theirs.
    expect(await attach(picture, { org: other.slug, vendor: vendorId })).toEqual({ nav: 'notFound' });
    expect(await attach(picture, { org: c.slug, vendor: vendorId })).toEqual({ nav: 'notFound' });
    expect(await view(mine!.id, { org: other.slug, vendor: vendorId })).toEqual({ nav: 'notFound' });
    expect(await view(mine!.id, { org: other.slug, vendor: theirVendor })).toEqual({ nav: 'notFound' });
    expect(await view(mine!.id, { org: c.slug })).toEqual({ nav: 'notFound' });
    expect(await outcome(removeVendorAttachment(other.slug, { id: mine!.id }))).toEqual({ nav: 'notFound' });
    expect(await snapshot()).toBe(before);
    // Her own vendor takes one; and it cannot be moved onto theirs.
    expect(await attach(picture, { org: other.slug, vendor: theirVendor, label: 'Theirs' })).toMatchObject({ status: 303 });
    const theirs = (await rows(other.id))[0]!;
    await expect(db.$executeRawUnsafe(`UPDATE "VendorAttachment" SET "vendorId" = '${vendorId}' WHERE "id" = '${theirs.id}'`)).rejects.toThrow(/same workspace/);
    await expect(db.$executeRawUnsafe(`UPDATE "VendorAttachment" SET "bytes" = '\\x25504446', "size" = 4 WHERE "id" = '${theirs.id}'`)).rejects.toThrow(/VendorAttachment_bytes_check/); // "%PDF"
    // An attachment under the wrong vendor id is not found either.
    await as(c.a);
    await ok(weddingActions.addVendor(c.slug, { name: 'Second Vendor', category: 'dj', contactName: '', email: '', phone: '' }));
    const second = (await db.vendor.findFirstOrThrow({ where: { orgId: c.orgId, name: 'Second Vendor' } })).id;
    expect(await view(mine!.id, { vendor: second })).toEqual({ nav: 'notFound' });
    expect(((await view(mine!.id)).result as Response).status).toBe(200);
  });
});
