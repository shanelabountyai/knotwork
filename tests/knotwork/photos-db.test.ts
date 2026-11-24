import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cronJobs } from '@/app/cron-jobs';
import { exportSkipped, exportTables } from '@/app/export-hooks';
import * as weddingActions from '@/app/o/[org]/wedding/actions';
import * as photoActions from '@/app/o/[org]/wedding/photos/actions';
import { GET as feedRoute } from '@/app/o/[org]/wedding/photos/[event]/wall/feed/route';
import { GET as zipRoute } from '@/app/o/[org]/wedding/photos/[event]/zip/route';
import { GET as imageRoute } from '@/app/o/[org]/wedding/photos/image/[photo]/[kind]/route';
import { POST as uploadRoute } from '@/app/p/[token]/upload/route';
import { advanceClock, now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { hashToken, newToken } from '@/core/tokens';
import { parseAction } from '@/lib/knotwork/changelog-diff';
import { addDays, todayIn } from '@/lib/knotwork/days';
import { expand, limitKeys, PHOTO_LIMITS, type Attempt, type Burst } from '@/lib/knotwork/photos/limits';
import { PHOTO_PROBLEM } from '@/lib/knotwork/photos/projection';
import { DEVICE_COOKIE, openUpload, purgePhotosEverywhere, readUploadPage } from '@/lib/knotwork/photos/public';
import { qrSvg } from '@/lib/knotwork/photos/qr';
import { loadAlbum, loadConsole, loadEvents, uploadLink, wallFeed } from '@/lib/knotwork/photos/store';
import { sequence } from '@/lib/knotwork/photos/wall';
import { inspect } from '@/lib/knotwork/uploads/inspect';
import { addMember, makeOrg } from '../helpers/org';
import { as, db, goToDay, log, makeWedding, ok, outcome, refused, snapshot, type Couple } from './db';
import { readJson } from './fixtures';
import { answer, caseBytes, expectClean, fixture, flat, leaksIn, manifest, multipart } from './uploads';

const { createPhotoEvent, moderatePhoto, purgeExpiredPhotos, replacePhotoLink, setPhotoDeviceBlocked, setPhotoHidden, setPhotoUploads, updatePhotoEvent } = photoActions;

// The photo wall (PRD P0-6) through the real upload route, the real actions and the real signed-in routes.
// A wedding thirty days out; one event, "Reception", moderated after the fact (post) unless a test says otherwise.
const today = () => todayIn('America/Chicago', now());
const IP = '203.0.113.20';
const NO = /You do not have access to that/;
let c: Couple;
let date: string;
let eventId: string;
let token: string;

const tokenOf = async (orgId: string, id: string) => (await withOrg({ orgId }, (tx) => uploadLink(tx, { orgId }, id)))!.split('/p/')[1]!;
const newEvent = async (slug: string, input: Record<string, unknown>) => (await ok(createPhotoEvent(slug, input))).split('/photos/')[1]!;
type Sent = { name?: string; caption?: string; cookie?: string | null; ip?: string; headers?: Record<string, string>; fileName?: string; fileType?: string; token?: string };
async function send(bytes: Uint8Array | null, o: Sent = {}) {
  const t = o.token ?? token;
  const headers = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': o.ip ?? IP, ...(o.cookie ? { cookie: `theme=dark; ${DEVICE_COOKIE}=${o.cookie}` } : {}), ...o.headers };
  const req = multipart(`http://localhost:8400/p/${t}/upload`, 'photo', bytes, { name: o.name ?? '', caption: o.caption ?? '' }, headers, o.fileName, o.fileType);
  return answer(await uploadRoute(req, { params: Promise.resolve({ token: t }) }));
}
const cookieIn = (setCookie: string | null) => new RegExp(`${DEVICE_COOKIE}=([\\w-]+)`).exec(setCookie ?? '')?.[1] ?? null;
const photos = (orgId = c.orgId) => db.photo.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { blobs: { orderBy: { kind: 'asc' } } } });
const lastPhoto = async () => (await photos()).at(-1)!;
const feedIds = async (id = eventId) => (await withOrg({ orgId: c.orgId }, (tx) => wallFeed(tx, { orgId: c.orgId }, id))).map((p) => p.id);
const albumIds = async (id = eventId) => (await withOrg({ orgId: c.orgId }, (tx) => loadAlbum(tx, { orgId: c.orgId }, id))).map((p) => p.id);
const consoleOf = (id = eventId) => withOrg({ orgId: c.orgId }, (tx) => loadConsole(tx, { orgId: c.orgId }, id));
const events = () => withOrg({ orgId: c.orgId }, (tx) => loadEvents(tx, { orgId: c.orgId }));
const get = (route: (req: Request, ctx: { params: Promise<never> }) => Promise<Response>, params: Record<string, string>) => outcome(route(new Request('http://localhost:8400/x'), { params: Promise.resolve(params as never) }));
const image = (photo: string, kind = 'display', org = c.slug) => get(imageRoute as never, { org, photo, kind });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const unzip = (zip: Uint8Array) => {
  const path = join(mkdtempSync(join(tmpdir(), 'kw-gallery-')), 'g.zip');
  writeFileSync(path, zip);
  return JSON.parse(execFileSync('python3', ['-I', '-c', 'import zipfile,sys,json,hashlib\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"files":[[i.filename,i.compress_type,hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()],"captions":z.read("captions.txt").decode()}))', path], { encoding: 'utf8' })) as { bad: string | null; files: [string, number, string][]; captions: string };
};

beforeEach(async () => {
  date = addDays(today(), 30);
  c = await makeWedding(date);
  eventId = await newEvent(c.slug, { name: 'Reception', mode: 'post', uploadDays: '7', retentionDays: '365' });
  token = await tokenOf(c.orgId, eventId);
});

describe('the upload link: a token, no account (PRD P0-6)', () => {
  it('shows the wedding\'s title and the event\'s name, and nothing else', async () => {
    expect(await readUploadPage(token, IP)).toEqual({ weddingTitle: 'Juniper & Rowan', eventName: 'Reception' });
  });
  it('the token is 32 random bytes kept only as a sha256 and a sealed copy; the device cookie only as a sha256', async () => {
    expect(token).toMatch(/^[\w-]{43}$/);
    const sent = await send(await flat(1, 2, 3));
    const cookie = cookieIn(sent.cookie)!;
    expect(cookie).toMatch(/^[\w-]{43}$/);
    const event = await db.photoEvent.findUniqueOrThrow({ where: { id: eventId } });
    const device = await db.photoDevice.findFirstOrThrow({ where: { orgId: c.orgId } });
    expect([event.uploadTokenHash, device.tokenHash]).toEqual([hashToken(token), hashToken(cookie)]);
    const everything = await snapshot();
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(cookie);
    // httpOnly, SameSite=Lax, scoped to the upload pages; Secure whenever the app is served over https.
    expect(sent.cookie).toMatch(/HttpOnly/i);
    expect(sent.cookie).toMatch(/SameSite=lax/i);
    expect(sent.cookie).toMatch(/Path=\/p(;|$)/);
    expect(sent.cookie).toMatch(/Max-Age=\d{7,}/);
  });
  it('an unknown, malformed, closed, expired or replaced link is the same nothing on the page and the same 404 on the post, and writes nothing', async () => {
    const closed = await newEvent(c.slug, { name: 'Closed', mode: 'post', uploadDays: '7', retentionDays: '365' });
    const closedToken = await tokenOf(c.orgId, closed);
    await ok(setPhotoUploads(c.slug, { id: closed, open: 'closed' }));
    const replaced = await newEvent(c.slug, { name: 'Replaced', mode: 'post', uploadDays: '7', retentionDays: '365' });
    const oldToken = await tokenOf(c.orgId, replaced);
    const notice = String(((await outcome(replacePhotoLink(c.slug, { id: replaced, confirm: 'on' }))).result as { notice: string }).notice);
    const newTokenOfReplaced = await tokenOf(c.orgId, replaced);
    expect(notice).toContain(`/p/${newTokenOfReplaced}`);
    expect(newTokenOfReplaced).not.toBe(oldToken);
    const before = await snapshot();
    const picture = await flat(9, 9, 9);
    const answers = [];
    for (const bad of ['x'.repeat(43), newToken(), 'short', `${token}x`.repeat(3), '../../etc/passwd', '', closedToken, oldToken]) {
      expect(await readUploadPage(bad, IP), bad).toBeNull();
      answers.push(await send(picture, { token: bad }));
    }
    for (const a of answers) expect(a).toEqual(answers[0]); // status, body, headers: indistinguishable
    expect([answers[0]!.status, answers[0]!.text, answers[0]!.cookie]).toEqual([404, 'Not found', null]);
    expect(await snapshot()).toBe(before);
    // The replaced event's NEW link works, and re-opening the closed one brings its link back.
    expect((await send(picture, { token: newTokenOfReplaced })).location).toBe(`/p/${newTokenOfReplaced}?done=live`);
    await ok(setPhotoUploads(c.slug, { id: closed, open: 'open' }));
    expect(await readUploadPage(closedToken, IP)).toEqual({ weddingTitle: 'Juniper & Rowan', eventName: 'Closed' });
    // Neither token is in the change log.
    expect(JSON.stringify((await log(c.orgId)).map((e) => [e.action, e.data]))).not.toMatch(new RegExp(`${oldToken}|${newTokenOfReplaced}|${token}`));
  });
  it('the link stops uploadDays after the wedding date: a derived day, nothing stored', async () => {
    const picture = await flat(4, 4, 4);
    expect((await events())[0]).toMatchObject({ lastUploadDay: addDays(date, 7), lastKeptDay: addDays(date, 365), linkOpen: true, purgeDue: false });
    goToDay(addDays(date, 7)); // the last day
    expect(await readUploadPage(token, IP)).not.toBeNull();
    expect((await send(picture)).status).toBe(303);
    goToDay(addDays(date, 8));
    expect(await readUploadPage(token, IP)).toBeNull();
    expect((await send(picture)).status).toBe(404);
    expect((await photos()).length).toBe(1);
    // Giving the event more days re-opens the same link: the day was never stored.
    await as(c.a);
    await ok(updatePhotoEvent(c.slug, { id: eventId, name: 'Reception', mode: 'post', uploadDays: '10', retentionDays: '365' }));
    expect(await readUploadPage(token, IP)).not.toBeNull();
    const columns = await db.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'PhotoEvent'`;
    expect(columns.map((x) => x.column_name).sort()).toEqual(['createdAt', 'createdById', 'id', 'mode', 'name', 'orgId', 'retentionDays', 'uploadDays', 'uploadTokenHash', 'uploadTokenSealed', 'uploadsOpen']);
  });
  it('a post from another site is a 404; a post from this one is answered with a redirect that carries only a code', async () => {
    const picture = await flat(5, 5, 5);
    const before = await snapshot();
    expect((await send(picture, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(404);
    expect((await send(picture, { headers: { 'sec-fetch-site': '', origin: 'https://evil.example' } })).status).toBe(404);
    expect(await snapshot()).toBe(before);
    const sent = await send(picture, { name: 'Ada <b>', caption: 'First dance & cake' });
    expect([sent.status, sent.location, sent.headers['cache-control']]).toEqual([303, `/p/${token}?done=live`, 'no-store']);
    expect(await lastPhoto()).toMatchObject({ uploaderName: 'Ada <b>', caption: 'First dance & cake', status: 'live' });
  });
  it('the QR code is an SVG of the link, made on the server', async () => {
    const svg = await qrSvg(`http://localhost:8400/p/${token}`);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).not.toMatch(/<script|href=|<image|<foreignObject/i);
    expect(await qrSvg(`http://localhost:8400/p/${token}`)).toBe(svg);
    expect(await qrSvg('http://localhost:8400/p/other')).not.toBe(svg);
  });
});

describe('RULE 4 on what is actually stored: stripped, validated, capped', () => {
  it('a phone photo with EXIF, a GPS position, XMP, an ICC profile and a comment is stored as three clean JPEGs', async () => {
    const raw = fixture('phone-gps.jpg');
    expect(leaksIn(raw)).toContain('Example Lane');
    const sent = await send(raw, { name: 'Linda', caption: 'From the back row', fileName: 'IMG_4412.JPG' });
    expect(sent.location).toBe(`/p/${token}?done=live`);
    const [p] = await photos();
    expect(p).toMatchObject({ mime: 'image/jpeg', width: 640, height: 480, status: 'live', uploaderName: 'Linda', caption: 'From the back row', purgedAt: null });
    expect(p!.blobs.map((b) => [b.kind, b.width, b.height])).toEqual([['full', 640, 480], ['display', 640, 480], ['thumb', 400, 300]]);
    for (const b of p!.blobs) {
      await expectClean(b.bytes, b.kind);
      expect(b.size).toBe(b.bytes.length);
      expect(Buffer.from(b.bytes).equals(raw)).toBe(false);
    }
    // Nothing of the file's metadata is anywhere in the database: not in a blob, a row or the log. Nor is its name.
    const everything = await snapshot();
    for (const leak of ['Example Lane', 'Synthetic Guest', 'Knotwork Fixture Cam', 'IMG_4412']) {
      expect(everything).not.toContain(leak);
      expect(everything).not.toContain(Buffer.from(leak, 'latin1').toString('hex')); // bytea is printed as hex
    }
    expect(everything).not.toContain(sha(raw));
  });
  it.each(manifest().cases.filter((x) => x.expect.result === 'ok').map((x) => [x.file!, x] as const))('%s: what the database holds is clean, at the sizes the fixture states', async (_, fx) => {
    expect((await send(caseBytes(fx))).location).toBe(`/p/${token}?done=live`);
    const p = await lastPhoto();
    expect(Object.fromEntries(p.blobs.map((b) => [b.kind, { type: 'jpeg', width: b.width, height: b.height }]))).toEqual(fx.expect.stored);
    for (const b of p.blobs) await expectClean(b.bytes, `${fx.file} ${b.kind}`);
  });
  it.each(manifest().cases.filter((x) => x.expect.result !== 'ok').map((x) => [x.file ?? 'oversize (synthesized)', x] as const))('%s is refused with its code and nothing is stored', async (_, fx) => {
    const before = await snapshot();
    const sent = await send(caseBytes(fx), { fileName: 'holiday.jpg', fileType: 'image/jpeg' }); // the browser claims a JPEG every time
    expect([sent.status, sent.location]).toEqual([303, `/p/${token}?e=${fx.expect.result}`]);
    expect(PHOTO_PROBLEM[fx.expect.result as keyof typeof PHOTO_PROBLEM]).toBeTruthy();
    expect(await snapshot()).toBe(before);
  });
  it('the name and the declared type are not read: a PNG called contract.pdf is stored, text called photo.jpg is not', async () => {
    expect((await send(fixture('alpha.png'), { fileName: 'contract.pdf', fileType: 'application/pdf' })).location).toBe(`/p/${token}?done=live`);
    expect((await send(Buffer.from('<html><script>alert(1)</script>'), { fileName: 'photo.jpg', fileType: 'image/jpeg' })).location).toBe(`/p/${token}?e=type`);
    expect((await photos()).length).toBe(1);
  });
  it('a post with no file, and a name or caption that is not one plain line, are refused and store nothing', async () => {
    const picture = await flat(7, 7, 7);
    const before = await snapshot();
    expect((await send(null)).location).toBe(`/p/${token}?e=empty`);
    expect((await send(picture, { caption: 'line one\nline two' })).location).toBe(`/p/${token}?e=text`);
    expect((await send(picture, { name: 'x'.repeat(61) })).location).toBe(`/p/${token}?e=name`);
    expect((await send(picture, { caption: 'y'.repeat(201) })).location).toBe(`/p/${token}?e=caption`);
    expect(await snapshot()).toBe(before);
  });
  it('the database refuses anything but a re-encoded JPEG of its true length, inside its rendition\'s box', async () => {
    await send(await flat(1, 1, 1));
    const p = await lastPhoto();
    const sql = (q: string) => db.$executeRawUnsafe(q);
    const insert = (bytes: string, size: number, w: number, h: number, kind = 'thumb', photoId = p.id, orgId = c.orgId) =>
      sql(`INSERT INTO "PhotoBlob" ("id", "orgId", "photoId", "kind", "bytes", "size", "width", "height") VALUES (gen_random_uuid(), '${orgId}', '${photoId}', '${kind}', '\\x${bytes}', ${size}, ${w}, ${h})`);
    await sql(`DELETE FROM "PhotoBlob" WHERE "photoId" = '${p.id}' AND "kind" = 'thumb'`);
    await expect(insert('89504e470d0a1a0a', 8, 1, 1)).rejects.toThrow(/PhotoBlob_bytes_check/); // a PNG
    await expect(insert('ffd8ffd9', 5, 1, 1)).rejects.toThrow(/PhotoBlob_bytes_check/); // a size that is not its length
    await expect(insert('ffd8ffd9', 4, 401, 10)).rejects.toThrow(/PhotoBlob_box_check/); // a thumb wider than 400
    await expect(insert('ffd8ffd9', 4, 1, 1)).resolves.toBe(1);
    await expect(sql(`UPDATE "Photo" SET "mime" = 'image/svg+xml' WHERE "id" = '${p.id}'`)).rejects.toThrow(/Photo_mime_check/);
    await expect(sql(`UPDATE "Photo" SET "status" = 'removed' WHERE "id" = '${p.id}'`)).rejects.toThrow(/Photo_removed_check/);
    await expect(sql(`UPDATE "PhotoEvent" SET "retentionDays" = 3, "uploadDays" = 9 WHERE "id" = '${eventId}'`)).rejects.toThrow(/PhotoEvent_days_check/);
  });
});

describe('moderation: pre and post, takedown with undo (PRD P0-6)', () => {
  it('post (the default): a photo is on the wall and in the album at once; a takedown removes it from both at once and can be undone', async () => {
    await send(await flat(10, 0, 0), { name: 'Ada' });
    await send(await flat(0, 10, 0), { name: 'Ben' });
    const [first, second] = await photos();
    expect(await feedIds()).toEqual([second!.id, first!.id]); // newest first
    expect(await albumIds()).toEqual([first!.id, second!.id]); // oldest first
    await ok(moderatePhoto(c.slug, { id: first!.id, action: 'take_down' }));
    expect([await feedIds(), await albumIds()]).toEqual([[second!.id], [second!.id]]);
    expect(await db.photo.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ status: 'removed', removedFrom: 'live' });
    expect((await consoleOf()).removed.map((p) => p.id)).toEqual([first!.id]);
    await as(c.b);
    await ok(moderatePhoto(c.slug, { id: first!.id, action: 'undo' }));
    expect([await feedIds(), await albumIds()]).toEqual([[second!.id, first!.id], [first!.id, second!.id]]);
    expect(await db.photo.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ status: 'live', removedFrom: null });
    const entries = (await log(c.orgId)).filter((e) => e.targetType === 'photo');
    expect(entries.map((e) => [e.action, e.actorUserId])).toEqual([['knotwork.photo.uploaded', null], ['knotwork.photo.uploaded', null], ['knotwork.photo.removed', c.a], ['knotwork.photo.restored', c.b]]);
    expect(entries[0]!.data).toMatchObject({ label: 'Photo from Ada at Reception', via: 'photo-link', after: { status: 'live', by: 'Ada' } });
    expect(entries[2]!.data).toMatchObject({ before: { status: 'live' }, after: { status: 'removed' } });
  });
  it('pre: a photo waits; approving puts it on the wall, rejecting does not, and a rejection can be undone', async () => {
    await ok(updatePhotoEvent(c.slug, { id: eventId, name: 'Reception', mode: 'pre', uploadDays: '7', retentionDays: '365' }));
    expect((await send(await flat(20, 0, 0))).location).toBe(`/p/${token}?done=pending`);
    expect((await send(await flat(0, 20, 0))).location).toBe(`/p/${token}?done=pending`);
    const [first, second] = await photos();
    expect([first!.status, second!.status]).toEqual(['pending', 'pending']);
    expect([await feedIds(), await albumIds()]).toEqual([[], []]);
    expect((await consoleOf()).queue.map((p) => p.id)).toEqual([first!.id, second!.id]); // oldest first
    await ok(moderatePhoto(c.slug, { id: first!.id, action: 'approve' }));
    await ok(moderatePhoto(c.slug, { id: second!.id, action: 'reject' }));
    expect([await feedIds(), await albumIds()]).toEqual([[first!.id], [first!.id]]);
    expect(await db.photo.findUniqueOrThrow({ where: { id: second!.id } })).toMatchObject({ status: 'removed', removedFrom: 'pending' });
    await ok(moderatePhoto(c.slug, { id: second!.id, action: 'undo' }));
    expect((await consoleOf()).queue.map((p) => p.id)).toEqual([second!.id]); // back to waiting, not onto the wall
    expect(await feedIds()).toEqual([first!.id]);
    // Switching the event back to post strands nothing: the waiting photo can still be approved.
    await ok(updatePhotoEvent(c.slug, { id: eventId, name: 'Reception', mode: 'post', uploadDays: '7', retentionDays: '365' }));
    expect((await send(await flat(0, 0, 20))).location).toBe(`/p/${token}?done=live`);
    await ok(moderatePhoto(c.slug, { id: second!.id, action: 'approve' }));
    expect((await feedIds()).length).toBe(3);
  });
  it('a move the machine does not allow is refused and writes nothing', async () => {
    await send(await flat(30, 0, 0));
    const p = await lastPhoto();
    const before = await snapshot();
    await refused(moderatePhoto(c.slug, { id: p.id, action: 'approve' }), /not waiting for a decision/);
    await refused(moderatePhoto(c.slug, { id: p.id, action: 'reject' }), /not waiting for a decision/);
    await refused(moderatePhoto(c.slug, { id: p.id, action: 'undo' }), /has not been removed/);
    await refused(moderatePhoto(c.slug, { id: p.id, action: 'burn' }), /./);
    expect(await snapshot()).toBe(before);
    await ok(moderatePhoto(c.slug, { id: p.id, action: 'take_down' }));
    await refused(moderatePhoto(c.slug, { id: p.id, action: 'take_down' }), /not on the wall/);
  });
  it('hide-from-wall and hide-from-album are independent, each can be put back, and neither is a takedown', async () => {
    for (const [r, g, b] of [[40, 0, 0], [0, 40, 0], [0, 0, 40]] as const) await send(await flat(r, g, b));
    const [a, b, d] = (await photos()).map((p) => p.id);
    await ok(setPhotoHidden(c.slug, { id: a!, where: 'wall', hidden: 'yes' }));
    await ok(setPhotoHidden(c.slug, { id: b!, where: 'album', hidden: 'yes' }));
    expect(await feedIds()).toEqual([d, b]); // a is off the wall only
    expect(await albumIds()).toEqual([a, d]); // b is out of the album only
    expect((await consoleOf()).live.map((p) => [p.id, p.hiddenFromWall, p.hiddenFromAlbum])).toEqual([[d, false, false], [b, false, true], [a, true, false]]);
    await ok(setPhotoHidden(c.slug, { id: a!, where: 'album', hidden: 'yes' })); // both, on one photo
    expect([await feedIds(), await albumIds()]).toEqual([[d, b], [d]]);
    expect((await db.photo.findUniqueOrThrow({ where: { id: a! } })).status).toBe('live');
    await refused(setPhotoHidden(c.slug, { id: a!, where: 'wall', hidden: 'yes' }), /already hidden from the wall/);
    await ok(setPhotoHidden(c.slug, { id: a!, where: 'wall', hidden: 'no' }));
    expect([await feedIds(), await albumIds()]).toEqual([[d, b, a], [d]]); // back on the wall, still out of the album
    await ok(setPhotoHidden(c.slug, { id: a!, where: 'album', hidden: 'no' }));
    await ok(setPhotoHidden(c.slug, { id: b!, where: 'album', hidden: 'no' }));
    expect([await feedIds(), await albumIds()]).toEqual([[d, b, a], [a, b, d]]);
    expect((await log(c.orgId)).filter((e) => /photo\.(hidden|shown)/.test(e.action)).map((e) => [e.action, (e.data as { after: object }).after])).toEqual([
      ['knotwork.photo.hidden', { hiddenFromWall: true }], ['knotwork.photo.hidden', { hiddenFromAlbum: true }], ['knotwork.photo.hidden', { hiddenFromAlbum: true }],
      ['knotwork.photo.shown', { hiddenFromWall: false }], ['knotwork.photo.shown', { hiddenFromAlbum: false }], ['knotwork.photo.shown', { hiddenFromAlbum: false }],
    ]);
  });
});

describe('devices and limits (PRD P0-6: "device blocking, per-device rate limits")', () => {
  it('a device is one cookie: the same browser is the same device, a browser with no cookie is a new one', async () => {
    const first = await send(await flat(50, 0, 0));
    const cookie = cookieIn(first.cookie)!;
    const again = await send(await flat(0, 50, 0), { cookie });
    expect(again.cookie).toBeNull(); // already has it
    await send(await flat(0, 0, 50)); // another browser
    const devices = (await consoleOf()).devices;
    expect(devices.map((d) => [d.number, d.photos, d.blocked])).toEqual([[1, 2, false], [2, 1, false]]);
    // A cookie that is not a token is treated as no cookie.
    const junk = await send(await flat(50, 50, 0), { cookie: '!!' });
    expect(cookieIn(junk.cookie)).toMatch(/^[\w-]{43}$/);
  });
  it('a blocked device\'s uploads are refused with a neutral sentence, storing nothing and counting nothing; others carry on; unblocking lets it back', async () => {
    const cookie = cookieIn((await send(await flat(60, 0, 0), { name: 'Trouble' })).cookie)!;
    const device = await db.photoDevice.findFirstOrThrow({ where: { orgId: c.orgId } });
    await ok(setPhotoDeviceBlocked(c.slug, { id: device.id, blocked: 'yes' }));
    expect(await db.photoDevice.findUniqueOrThrow({ where: { id: device.id } })).toMatchObject({ blockedById: c.a });
    const before = await snapshot();
    const limits = () => db.rateLimit.findMany({ where: { key: { startsWith: 'photo:device:' } }, orderBy: { key: 'asc' } });
    const counted = await limits();
    const sent = await send(await flat(0, 60, 0), { cookie });
    expect([sent.status, sent.location, sent.cookie]).toEqual([303, `/p/${token}?e=refused`, null]);
    expect(PHOTO_PROBLEM.refused).toBe('That photo could not be added. If you think this is a mistake, ask the couple.');
    expect(await snapshot()).toBe(before);
    expect(await limits()).toEqual(counted);
    // The photo it sent before stays (take it down by hand); another device is not affected.
    expect((await feedIds()).length).toBe(1);
    expect((await send(await flat(0, 0, 60))).location).toBe(`/p/${token}?done=live`);
    await refused(setPhotoDeviceBlocked(c.slug, { id: device.id, blocked: 'yes' }), /already blocked/);
    await ok(setPhotoDeviceBlocked(c.slug, { id: device.id, blocked: 'no' }));
    expect((await send(await flat(60, 60, 0), { cookie })).location).toBe(`/p/${token}?done=live`);
    expect((await log(c.orgId)).filter((e) => e.targetType === 'photodevice').map((e) => e.action)).toEqual(['knotwork.photodevice.blocked', 'knotwork.photodevice.unblocked']);
    // A block outlives a replaced link: the device is the cookie, not the link.
    await ok(setPhotoDeviceBlocked(c.slug, { id: device.id, blocked: 'yes' }));
    await outcome(replacePhotoLink(c.slug, { id: eventId, confirm: 'on' }));
    const fresh = await tokenOf(c.orgId, eventId);
    expect((await send(await flat(1, 60, 1), { cookie, token: fresh })).location).toBe(`/p/${fresh}?e=refused`);
  });

  // The rate-limit suite: the shipped-limits fixtures replayed against the real counters, attempt by attempt.
  type LimitFx = { name: string; limits?: unknown; blocked?: string[]; steps: (Attempt | Burst)[]; expect: { runs: [string, number][]; totals: Record<string, number> } };
  const shipped = ['01-under-every-limit', '02-one-device-over', '03-load-200-from-20-devices', '04-address-over'];
  it.each(shipped)('fixtures/photos/limits/%s: the store refuses exactly the attempts the fixture says', async (name) => {
    const fx = readJson<LimitFx>(`fixtures/photos/limits/${name}.json`);
    expect(fx.limits, 'only fixtures that run against the shipped limits can be replayed here').toBeUndefined();
    const zero = Date.parse(`${today()}T18:00:00Z`); // on the hour, so every window starts with the fixture
    const devices = new Map<string, string>();
    const got: string[] = [];
    for (const a of expand(fx.steps)) {
      advanceClock(zero + a.t * 1000 - Date.now()); // the app's clock reads exactly the fixture's second
      if (!devices.has(a.device)) devices.set(a.device, newToken());
      const r = await openUpload(token, a.address, devices.get(a.device)!);
      if (r === 'limited' || r === null) throw new Error(`attempt at ${a.t}: ${String(r)}`);
      got.push(r.ok ? 'ok' : r.code);
    }
    const want = fx.expect.runs.flatMap(([o, n]) => Array.from({ length: n }, () => (o === 'ok' ? 'ok' : 'busy')));
    expect(got).toEqual(want);
  }, 120_000);
  it('which limit refused is in the counters: the device\'s own counter runs past its limit while the address\'s stops at what was let through', async () => {
    const device = newToken();
    const keys = limitKeys(eventId, hashToken(device), IP);
    for (let i = 0; i < 35; i++) await openUpload(token, IP, device);
    const count = async (key: string) => (await db.rateLimit.findMany({ where: { key } })).reduce((n, r) => n + r.count, 0);
    expect([await count(keys.device), await count(keys.address), await count(keys.event)]).toEqual([35, 30, 30]);
    // Through the route, the refusal is a redirect with a code, the body is not kept, and nothing is stored.
    const before = await snapshot();
    const sent = await send(fixture('big.jpg'), { cookie: device });
    expect([sent.status, sent.location]).toEqual([303, `/p/${token}?e=busy`]);
    expect(await snapshot()).toBe(before);
    expect(PHOTO_LIMITS.upload.perDevice.limit).toBe(30);
  });
});

describe('the wall feed, the image route, the album and the gallery download', () => {
  it('the feed is the wall-visible photos, newest first, with the address of each display rendition; signed-in only', async () => {
    await send(await flat(70, 0, 0), { name: 'Ada', caption: 'One' });
    await send(await flat(0, 70, 0), { name: 'Ben', caption: 'Two' });
    const [first, second] = await photos();
    const res = (await get(feedRoute as never, { org: c.slug, event: eventId })).result as Response;
    expect([res.status, res.headers.get('cache-control')]).toEqual([200, 'private, no-store']);
    expect(await res.json()).toEqual({ photos: [
      { id: second!.id, by: 'Ben', caption: 'Two', src: `/o/${c.slug}/wedding/photos/image/${second!.id}/display` },
      { id: first!.id, by: 'Ada', caption: 'One', src: `/o/${c.slug}/wedding/photos/image/${first!.id}/display` },
    ] });
  });
  it('the image route sends the stored bytes with the stored type, tells the browser not to sniff, and keeps the answer private', async () => {
    await send(fixture('phone-gps.jpg'));
    const p = await lastPhoto();
    for (const b of p.blobs) {
      const res = (await image(p.id, b.kind)).result as Response;
      expect([res.status, res.headers.get('content-type'), res.headers.get('x-content-type-options'), res.headers.get('cache-control'), res.headers.get('content-length')]).toEqual([200, 'image/jpeg', 'nosniff', 'private, max-age=300', String(b.size)]);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(sha(body)).toBe(sha(b.bytes));
      expect(inspect(body)).toEqual([]);
    }
    expect(await image(p.id, 'original')).toMatchObject({ nav: 'notFound' }); // there is no original to ask for
    expect(await image('not-a-uuid')).toMatchObject({ nav: 'notFound' });
    expect(await image('00000000-0000-4000-8000-000000000000')).toMatchObject({ nav: 'notFound' });
  });
  it('the gallery zip holds the full rendition of every album-visible photo and nothing else', async () => {
    await send(await flat(80, 0, 0), { name: 'Ada', caption: 'Kept' });
    await send(await flat(0, 80, 0), { name: 'Ben', caption: 'Taken down' });
    await send(await flat(0, 0, 80), { name: 'Cy', caption: 'Hidden from the album' });
    await send(await flat(80, 80, 0), { name: 'Di', caption: 'Hidden from the wall' });
    const [kept, down, noAlbum, noWall] = await photos();
    await ok(moderatePhoto(c.slug, { id: down!.id, action: 'take_down' }));
    await ok(setPhotoHidden(c.slug, { id: noAlbum!.id, where: 'album', hidden: 'yes' }));
    await ok(setPhotoHidden(c.slug, { id: noWall!.id, where: 'wall', hidden: 'yes' }));
    const res = (await get(zipRoute as never, { org: c.slug, event: eventId })).result as Response;
    expect([res.status, res.headers.get('content-type'), res.headers.get('content-disposition'), res.headers.get('cache-control')]).toEqual([200, 'application/zip', 'attachment; filename="juniper-rowan-reception.zip"', 'private, no-store']);
    const zip = unzip(new Uint8Array(await res.arrayBuffer()));
    const full = (p: (typeof kept)) => sha(p!.blobs.find((b) => b.kind === 'full')!.bytes);
    expect(zip.bad).toBeNull();
    expect(zip.files.map((f) => [f[0], f[1]])).toEqual([['photo-0001.jpg', 0], ['photo-0002.jpg', 0], ['captions.txt', 0]]); // stored, not compressed
    expect([zip.files[0]![2], zip.files[1]![2]]).toEqual([full(kept), full(noWall)]);
    expect(zip.captions).toBe('file\tfrom\tcaption\nphoto-0001.jpg\tAda\tKept\nphoto-0002.jpg\tDi\tHidden from the wall\n');
    expect((await log(c.orgId)).at(-1)).toMatchObject({ action: 'knotwork.photoevent.downloaded', actorUserId: c.a });
  });
});

describe('retention: photos are purged retentionDays after the wedding date (derived; rule 1)', () => {
  it('nothing is purged through the last kept day; from the next day the bytes are deleted for good and the photo is marked purged', async () => {
    await send(await flat(90, 0, 0), { name: 'Ada', caption: 'Kept a year' });
    await send(await flat(0, 90, 0));
    const [first] = await photos();
    goToDay(addDays(date, 365)); // the last kept day
    await as(c.a);
    expect(await purgePhotosEverywhere()).toEqual({ orgs: 1, purged: 0 });
    await refused(purgeExpiredPhotos(c.slug, { confirm: 'on' }), /Nothing to delete/);
    expect(await db.photoBlob.count({ where: { orgId: c.orgId } })).toBe(6);

    goToDay(addDays(date, 366));
    await as(c.a);
    expect((await events())[0]).toMatchObject({ purgeDue: true, lastKeptDay: addDays(date, 365) });
    await refused(purgeExpiredPhotos(c.slug, {}), /Tick the box/);
    expect(((await cronJobs()) as { photoRetention: unknown }).photoRetention).toEqual({ orgs: 1, purged: 2 }); // the cron job list runs it
    expect(await db.photoBlob.count({ where: { orgId: c.orgId } })).toBe(0);
    const after = await photos();
    expect(after.map((p) => [p.uploaderName, p.caption, p.status, p.purgedAt instanceof Date])).toEqual([['Ada', 'Kept a year', 'live', true], ['', '', 'live', true]]);
    expect([await feedIds(), await albumIds()]).toEqual([[], []]);
    expect(await image(first!.id)).toMatchObject({ nav: 'notFound' });
    expect((await events())[0]!.counts).toEqual({ pending: 0, live: 0, removed: 0, purged: 2 });
    await refused(moderatePhoto(c.slug, { id: first!.id, action: 'take_down' }), /deleted for good/);
    await refused(setPhotoHidden(c.slug, { id: first!.id, where: 'wall', hidden: 'yes' }), /deleted for good/);
    expect((await log(c.orgId)).at(-1)).toMatchObject({ action: 'knotwork.photoevent.purged', actorUserId: null, data: { after: { photosPurged: 2, lastKeptDay: addDays(date, 365) } } });
    // Running it again finds nothing, and the workspace no longer holds photo bytes to look at.
    expect(await purgePhotosEverywhere()).toEqual({ orgs: 0, purged: 0 });
    // A purge is never undone, and a purged photo can hold no bytes again.
    await expect(db.$executeRawUnsafe(`UPDATE "Photo" SET "purgedAt" = NULL WHERE "id" = '${first!.id}'`)).rejects.toThrow(/a purge is never undone/);
    await expect(db.$executeRawUnsafe(`INSERT INTO "PhotoBlob" ("id", "orgId", "photoId", "kind", "bytes", "size", "width", "height") VALUES (gen_random_uuid(), '${c.orgId}', '${first!.id}', 'thumb', '\\xffd8ffd9', 4, 1, 1)`)).rejects.toThrow(/has not been purged/);
  });
  it('the button does what the cron job does, one event at a time by its own days; an event not yet due keeps its photos', async () => {
    const short = await newEvent(c.slug, { name: 'Rehearsal dinner', mode: 'post', uploadDays: '1', retentionDays: '30' });
    const shortToken = await tokenOf(c.orgId, short);
    await send(await flat(1, 90, 1));
    await send(await flat(1, 1, 90), { token: shortToken });
    goToDay(addDays(date, 31));
    await as(c.b);
    expect((await outcome(purgeExpiredPhotos(c.slug, { confirm: 'on' }))).result).toEqual({ notice: '1 photo was deleted for good.' });
    expect((await events()).map((e) => [e.name, e.purgeDue, e.counts.live, e.counts.purged])).toEqual([['Reception', false, 1, 0], ['Rehearsal dinner', true, 0, 1]]);
    expect(await db.photoBlob.count({ where: { orgId: c.orgId } })).toBe(3);
    expect((await log(c.orgId)).at(-1)).toMatchObject({ action: 'knotwork.photoevent.purged', actorUserId: c.b });
  });
});

describe('who may do what, and another workspace\'s photos', () => {
  it('a helper sees and moderates only with the photo permission, and never manages an event', async () => {
    await send(await flat(100, 0, 0));
    const p = await lastPhoto();
    const device = await db.photoDevice.findFirstOrThrow({ where: { orgId: c.orgId } });
    await as(c.helper);
    await refused(moderatePhoto(c.slug, { id: p.id, action: 'take_down' }), NO);
    await refused(setPhotoHidden(c.slug, { id: p.id, where: 'wall', hidden: 'yes' }), NO);
    await refused(setPhotoDeviceBlocked(c.slug, { id: device.id, blocked: 'yes' }), NO);
    expect(await image(p.id)).toMatchObject({ nav: 'notFound' });
    expect(await get(feedRoute as never, { org: c.slug, event: eventId })).toMatchObject({ nav: 'notFound' });
    expect(await get(zipRoute as never, { org: c.slug, event: eventId })).toMatchObject({ nav: 'notFound' });
    await as(c.a);
    await ok(weddingActions.grantHelper(c.slug, { userId: c.helper, scope: 'photos_moderate' }));
    await as(c.helper);
    expect(((await image(p.id)).result as Response).status).toBe(200);
    expect(((await get(feedRoute as never, { org: c.slug, event: eventId })).result as Response).status).toBe(200);
    await ok(moderatePhoto(c.slug, { id: p.id, action: 'take_down' }));
    expect(((await image(p.id)).result as Response).status).toBe(200); // a moderator can still look at what was removed
    await ok(moderatePhoto(c.slug, { id: p.id, action: 'undo' }));
    await ok(setPhotoDeviceBlocked(c.slug, { id: device.id, blocked: 'yes' }));
    // Not theirs: making an event, its settings, its link, the purge.
    await refused(createPhotoEvent(c.slug, { name: 'After-party', mode: 'post', uploadDays: '7', retentionDays: '365' }), NO);
    await refused(updatePhotoEvent(c.slug, { id: eventId, name: 'Mine now', mode: 'post', uploadDays: '7', retentionDays: '365' }), NO);
    await refused(setPhotoUploads(c.slug, { id: eventId, open: 'closed' }), NO);
    await refused(replacePhotoLink(c.slug, { id: eventId, confirm: 'on' }), NO);
    await refused(purgeExpiredPhotos(c.slug, { confirm: 'on' }), NO);
    expect((await log(c.orgId)).filter((e) => e.actorUserId === c.helper).map((e) => e.action)).toEqual(['knotwork.photo.removed', 'knotwork.photo.restored', 'knotwork.photodevice.blocked']);
  });
  it('event rules: a name once, days within bounds, photos kept at least as long as uploads stay open', async () => {
    const base = { mode: 'post', uploadDays: '7', retentionDays: '365' };
    await refused(createPhotoEvent(c.slug, { ...base, name: 'Reception' }), /already a photo event called Reception/);
    await refused(createPhotoEvent(c.slug, { ...base, name: '' }), /name is required/);
    await refused(createPhotoEvent(c.slug, { ...base, name: 'X', uploadDays: '366' }), /0 to 365 days/);
    await refused(createPhotoEvent(c.slug, { ...base, name: 'X', retentionDays: '0' }), /1 to 3650 days/);
    await refused(createPhotoEvent(c.slug, { ...base, name: 'X', uploadDays: '30', retentionDays: '10' }), /at least as long/);
    await refused(createPhotoEvent(c.slug, { ...base, name: 'X', uploadDays: 'soon' }), /whole number/);
    await refused(createPhotoEvent(c.slug, { ...base, name: 'X', mode: 'never' }), /./);
    await refused(replacePhotoLink(c.slug, { id: eventId }), /Tick the box/);
    await refused(setPhotoUploads(c.slug, { id: eventId, open: 'open' }), /already open/);
    expect((await events()).map((e) => e.name)).toEqual(['Reception']);
    const created = (await log(c.orgId)).find((e) => e.action === 'knotwork.photoevent.created')!;
    expect(created.data).toMatchObject({ label: 'Reception', after: { name: 'Reception', mode: 'post', uploadDays: 7, retentionDays: 365, uploadsOpen: true } });
    expect(JSON.stringify(created.data)).not.toMatch(/[0-9a-f]{64}/);
  });
  it('another workspace\'s event, photo and device are not found: by action, by image, by feed, by zip, and in the database', async () => {
    await send(await flat(110, 0, 0));
    const mine = await lastPhoto();
    const myDevice = await db.photoDevice.findFirstOrThrow({ where: { orgId: c.orgId } });
    const other = await makeOrg('sage-and-wren');
    const sage = (await addMember(other.id, 'owner', 'sage@example.test')).id;
    await as(sage);
    await ok(weddingActions.createWedding(other.slug, { title: 'Sage & Wren', date, timeZone: 'America/Chicago' }));
    const theirEvent = await newEvent(other.slug, { name: 'Reception', mode: 'post', uploadDays: '7', retentionDays: '365' });
    const theirToken = await tokenOf(other.id, theirEvent);
    await send(await flat(0, 110, 0), { token: theirToken });
    const theirs = (await photos(other.id))[0]!;
    const before = await snapshot();
    // Sage, signed in to her own workspace, reaches for Juniper and Rowan's rows by id.
    for (const attempt of [
      () => moderatePhoto(other.slug, { id: mine.id, action: 'take_down' }), () => setPhotoHidden(other.slug, { id: mine.id, where: 'wall', hidden: 'yes' }),
      () => setPhotoDeviceBlocked(other.slug, { id: myDevice.id, blocked: 'yes' }), () => updatePhotoEvent(other.slug, { id: eventId, name: 'Taken', mode: 'post', uploadDays: '7', retentionDays: '365' }),
      () => setPhotoUploads(other.slug, { id: eventId, open: 'closed' }), () => replacePhotoLink(other.slug, { id: eventId, confirm: 'on' }),
      () => moderatePhoto(c.slug, { id: mine.id, action: 'take_down' }), // and by their slug
    ]) expect(await outcome(attempt())).toEqual({ nav: 'notFound' });
    expect(await image(mine.id, 'display', other.slug)).toMatchObject({ nav: 'notFound' });
    expect(await image(mine.id, 'display', c.slug)).toMatchObject({ nav: 'notFound' });
    expect(await get(feedRoute as never, { org: other.slug, event: eventId })).toMatchObject({ nav: 'notFound' });
    expect(await get(zipRoute as never, { org: other.slug, event: eventId })).toMatchObject({ nav: 'notFound' });
    expect(await get(feedRoute as never, { org: c.slug, event: eventId })).toMatchObject({ nav: 'notFound' });
    expect(await snapshot()).toBe(before);
    // Her own are hers.
    expect(((await image(theirs.id, 'display', other.slug)).result as Response).status).toBe(200);
    // Each link reaches only its own event, though both are called Reception.
    expect([(await photos(c.orgId)).length, (await photos(other.id)).length]).toEqual([1, 1]);
    // The database's own guard: a photo cannot point at another workspace's event or device.
    await expect(db.$executeRawUnsafe(`UPDATE "Photo" SET "eventId" = '${eventId}' WHERE "id" = '${theirs.id}'`)).rejects.toThrow(/same workspace/);
    await expect(db.$executeRawUnsafe(`UPDATE "Photo" SET "deviceId" = '${myDevice.id}' WHERE "id" = '${theirs.id}'`)).rejects.toThrow(/same event/);
    await expect(db.$executeRawUnsafe(`UPDATE "PhotoBlob" SET "photoId" = '${mine.id}' WHERE "photoId" = '${theirs.id}' AND "kind" = 'full'`)).rejects.toThrow(/same workspace/);
    // And the retention purge in one workspace leaves the other alone.
    await as(c.a);
    await ok(updatePhotoEvent(c.slug, { id: eventId, name: 'Reception', mode: 'post', uploadDays: '7', retentionDays: '30' }));
    goToDay(addDays(date, 31));
    expect(await purgePhotosEverywhere()).toEqual({ orgs: 2, purged: 1 });
    expect([await db.photoBlob.count({ where: { orgId: c.orgId } }), await db.photoBlob.count({ where: { orgId: other.id } })]).toEqual([0, 3]);
  });
  it('the data export carries the facts and never a byte, a link hash or a device hash; every photo entity is in the change log', async () => {
    const cookie = cookieIn((await send(fixture('phone-gps.jpg'), { name: 'Ada', caption: 'Exported' })).cookie)!;
    const p = await lastPhoto();
    const exported = await withOrg({ orgId: c.orgId }, async (tx) => Promise.all(exportTables.map(async (t) => ({ name: t.name, rows: await t.rows(tx, c.orgId) }))));
    const byName = Object.fromEntries(exported.map((t) => [t.name, t.rows as Record<string, unknown>[]]));
    expect(byName.Photo).toEqual([expect.objectContaining({ id: p.id, uploaderName: 'Ada', caption: 'Exported', status: 'live', mime: 'image/jpeg', width: 640, height: 480 })]);
    expect(Object.keys(byName.PhotoEvent![0]!).sort()).toEqual(['createdAt', 'createdById', 'id', 'mode', 'name', 'orgId', 'retentionDays', 'uploadDays', 'uploadsOpen']);
    expect(Object.keys(byName.PhotoDevice![0]!).sort()).toEqual(['blockedAt', 'blockedById', 'createdAt', 'eventId', 'id', 'orgId']);
    expect(byName.PhotoBlob).toBeUndefined();
    expect(exportSkipped.PhotoBlob).toMatch(/gallery download/);
    const text = JSON.stringify(exported, (_, v) => (v instanceof Uint8Array ? `BYTES:${v.length}` : v));
    expect(text).not.toMatch(/BYTES:|[0-9a-f]{64}/);
    for (const secret of [token, cookie, hashToken(token), hashToken(cookie)]) expect(text).not.toContain(secret);
    // The log: who, what, before and after, for all three photo entities; nothing token-shaped.
    const device = await db.photoDevice.findFirstOrThrow({ where: { orgId: c.orgId } });
    await ok(setPhotoDeviceBlocked(c.slug, { id: device.id, blocked: 'yes' }));
    const all = await log(c.orgId);
    expect(new Set(all.map((e) => parseAction(e.action)!.entity))).toEqual(new Set(['wedding', 'baseline', 'photoevent', 'photo', 'photodevice']));
    expect(JSON.stringify(all.map((e) => e.data))).not.toMatch(/\b[0-9a-f]{64}\b/);
  });
});

describe('the load case (PRD P0-6 metric): 200 uploads in 10 minutes from 20 devices, none lost', () => {
  it('every one is stored, clean, and in the wall feed; the wall shows all 200', async () => {
    const start = Date.parse(`${today()}T18:00:00Z`);
    const cookies: (string | null)[] = Array.from({ length: 20 }, () => null);
    const sentHashes: string[] = [];
    for (let i = 0; i < 200; i++) {
      advanceClock(start + i * 3_000 - Date.now()); // one every three seconds on the app's clock: 597 seconds in all
      const d = i % 20;
      const picture = await flat(i, (i * 7) % 256, (i * 13) % 256, 96, 64);
      sentHashes.push(sha(picture));
      const sent = await send(picture, { cookie: cookies[d], name: `Guest ${d + 1}`, caption: `Photo ${i + 1}` });
      expect(sent.location, `upload ${i + 1}`).toBe(`/p/${token}?done=live`);
      cookies[d] ??= cookieIn(sent.cookie);
    }
    const stored = await photos();
    expect(stored).toHaveLength(200);
    expect(stored.map((p) => p.caption)).toEqual(Array.from({ length: 200 }, (_, i) => `Photo ${i + 1}`)); // in order, none missing, none twice
    const seconds = (stored.at(-1)!.createdAt.getTime() - stored[0]!.createdAt.getTime()) / 1000;
    expect(seconds).toBeGreaterThan(590);
    expect(seconds).toBeLessThan(600); // inside ten minutes
    const devices = (await consoleOf()).devices;
    expect(devices.map((d) => d.photos)).toEqual(Array.from({ length: 20 }, () => 10));
    expect(await db.photoBlob.count({ where: { orgId: c.orgId } })).toBe(600);
    // 200 different pictures went in and 200 different pictures are stored: nothing overwrote anything.
    expect(new Set(stored.map((p) => sha(p.blobs.find((b) => b.kind === 'display')!.bytes))).size).toBe(200);
    for (const p of stored) for (const b of p.blobs) expect(inspect(b.bytes), `${p.caption} ${b.kind}`).toEqual([]);
    expect(stored.some((p) => p.blobs.some((b) => sentHashes.includes(sha(b.bytes))))).toBe(false); // never the raw upload
    // The wall: the feed route returns all 200, newest first, and one lap of the wall shows every one of them.
    await as(c.a);
    const res = (await get(feedRoute as never, { org: c.slug, event: eventId })).result as Response;
    const feed = ((await res.json()) as { photos: { id: string; caption: string }[] }).photos;
    expect(feed.map((p) => p.caption)).toEqual(Array.from({ length: 200 }, (_, i) => `Photo ${200 - i}`));
    expect(new Set(sequence(feed.map((p) => p.id), 200))).toEqual(new Set(stored.map((p) => p.id)));
    // And each is served.
    for (const p of [feed[0]!, feed[99]!, feed[199]!]) expect(((await image(p.id)).result as Response).status).toBe(200);
    expect((await log(c.orgId)).filter((e) => e.action === 'knotwork.photo.uploaded')).toHaveLength(200);
  }, 180_000);
});
