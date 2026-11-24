import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canSeeEntity, allows, GRANT_SCOPES } from '@/lib/knotwork/access';
import { EVENT_DEFAULTS, lastKeptDay, lastUploadDay, linkOpen, purgeDue } from '@/lib/knotwork/photos/dates';
import { asLimit, expand, limitKeys, PHOTO_LIMITS, simulate } from '@/lib/knotwork/photos/limits';
import { ACTIONS, inAlbum, initialStatus, moderate, MODES, onWall, STATES, table, type PhotoState } from '@/lib/knotwork/photos/moderation';
import { checkText, isPhotoDone, isPhotoProblem, PHOTO_PROBLEM, uploadView } from '@/lib/knotwork/photos/projection';
import { nextOnWall, remember, sequence } from '@/lib/knotwork/photos/wall';
import { crc32, zipStored } from '@/lib/knotwork/photos/zip';
import { UPLOAD_PROBLEM } from '@/lib/knotwork/uploads/caps';
import { LIMITS_DIR, MODERATION_FILE, regenerateLimits, regenerateModeration, type LimitFx } from '../../scripts/knotwork/gen-photo-fixtures';
import { readJson, ROOT } from './fixtures';

// The photo wall's pure parts (PRD P0-6): the moderation machine, what the wall shows next, the upload limits, the
// two derived days, the zip writer and the guest's projection. No database, no clock.

describe('moderation: pre and post, takedown with undo (fixtures/photos/moderation.json)', () => {
  const fx = readJson<ReturnType<typeof table>>(MODERATION_FILE);
  it('the committed table is the machine\'s, and covers every state × action × mode, purged and not', () => {
    expect(readFileSync(join(ROOT, MODERATION_FILE), 'utf8')).toBe(regenerateModeration());
    expect(fx.moves).toHaveLength(MODES.length * STATES.length * ACTIONS.length * 2);
    for (const m of fx.moves) expect(moderate(m.state, m.action, m.mode, m.purged), JSON.stringify(m)).toEqual(m.expect);
  });
  it('post: a photo is live at once; pre: it waits', () => {
    expect([initialStatus('post'), initialStatus('pre')]).toEqual(['live', 'pending']);
    expect(fx.initial).toEqual({ pre: 'pending', post: 'live' });
  });
  it('the moves, by hand', () => {
    const pending: PhotoState = { status: 'pending', removedFrom: null };
    const live: PhotoState = { status: 'live', removedFrom: null };
    expect(moderate(pending, 'approve', 'pre')).toEqual({ ok: true, next: live });
    expect(moderate(pending, 'reject', 'pre')).toEqual({ ok: true, next: { status: 'removed', removedFrom: 'pending' } });
    expect(moderate(live, 'take_down', 'post')).toEqual({ ok: true, next: { status: 'removed', removedFrom: 'live' } });
    expect(moderate(live, 'approve', 'post')).toEqual({ ok: false, code: 'not-pending' });
    expect(moderate(pending, 'take_down', 'pre')).toEqual({ ok: false, code: 'not-live' });
    expect(moderate(live, 'undo', 'post')).toEqual({ ok: false, code: 'not-removed' });
  });
  it('a takedown and a rejection are each undone to exactly where the photo was; a second undo is refused', () => {
    for (const [start, action] of [[STATES[1]!, 'take_down'], [STATES[0]!, 'reject']] as const) {
      for (const mode of MODES) {
        const down = moderate(start, action, mode);
        if (!down.ok) throw new Error('refused');
        expect(down.next.status).toBe('removed');
        const back = moderate(down.next, 'undo', mode);
        expect(back).toEqual({ ok: true, next: start });
        if (back.ok) expect(moderate(back.next, 'undo', mode)).toEqual({ ok: false, code: 'not-removed' });
      }
    }
  });
  it('the mode decides only where a photo starts: every move is the same in both, so switching modes strands nothing', () => {
    for (const state of STATES) for (const action of ACTIONS) expect(moderate(state, action, 'pre')).toEqual(moderate(state, action, 'post'));
    // From every state there is a way to live and a way to removed.
    for (const state of STATES) expect(ACTIONS.some((a) => moderate(state, a, 'post').ok), JSON.stringify(state)).toBe(true);
  });
  it('a purged photo takes no move', () => {
    for (const state of STATES) for (const action of ACTIONS) expect(moderate(state, action, 'post', true)).toEqual({ ok: false, code: 'purged' });
  });
  it('hide-from-wall and hide-from-album are independent: each changes one place and never the other', () => {
    expect(fx.visibility).toHaveLength(3 * 2 * 2 * 2);
    for (const v of fx.visibility) expect([onWall(v), inAlbum(v)], JSON.stringify(v)).toEqual([v.wall, v.album]);
    const live = { status: 'live' as const, purged: false };
    expect([onWall({ ...live, hiddenFromWall: true, hiddenFromAlbum: false }), inAlbum({ ...live, hiddenFromWall: true, hiddenFromAlbum: false })]).toEqual([false, true]);
    expect([onWall({ ...live, hiddenFromWall: false, hiddenFromAlbum: true }), inAlbum({ ...live, hiddenFromWall: false, hiddenFromAlbum: true })]).toEqual([true, false]);
    for (const hiddenFromAlbum of [false, true]) for (const hiddenFromWall of [false, true]) {
      expect(onWall({ ...live, hiddenFromWall, hiddenFromAlbum })).toBe(!hiddenFromWall);
      expect(inAlbum({ ...live, hiddenFromWall, hiddenFromAlbum })).toBe(!hiddenFromAlbum);
    }
    // Nothing that is pending, removed or purged is anywhere, whatever its flags.
    for (const v of fx.visibility.filter((x) => x.status !== 'live' || x.purged)) expect([v.wall, v.album]).toEqual([false, false]);
  });
});

describe('the wall: newest first, then rotation (PRD P0-6)', () => {
  it('from a standing start it shows the newest first, walks to the oldest, then goes round again in the same order', () => {
    const feed = ['e', 'd', 'c', 'b', 'a']; // newest first
    expect(sequence(feed, 12)).toEqual(['e', 'd', 'c', 'b', 'a', 'e', 'd', 'c', 'b', 'a', 'e', 'd']);
  });
  it('a new photo goes up next, ahead of the rotation; then the rotation carries on where it was', () => {
    const shown = sequence(['c', 'b', 'a'], 4); // c b a c
    expect(shown).toEqual(['c', 'b', 'a', 'c']);
    const feed = ['e', 'd', 'c', 'b', 'a']; // d and e arrive, e newest
    expect(sequence(feed, 7, shown)).toEqual(['e', 'd', 'b', 'a', 'c', 'e', 'd']);
  });
  it('a photo that was taken down is never shown again, whatever the screen remembers', () => {
    const shown = ['c', 'b', 'a'];
    expect(sequence(['c', 'a'], 4, shown)).toEqual(['c', 'a', 'c', 'a']);
    expect(nextOnWall([], shown)).toBeNull();
    expect(nextOnWall(['z'], [])).toBe('z');
    expect(sequence(['z'], 3)).toEqual(['z', 'z', 'z']);
  });
  it('every photo in the feed is shown within one lap, and no photo twice before every other has had its turn', () => {
    const feed = Array.from({ length: 200 }, (_, i) => `p${String(199 - i).padStart(3, '0')}`);
    const lap = sequence(feed, 200);
    expect(lap).toEqual(feed); // all 200, newest first: none lost
    const two = sequence(feed, 400);
    expect(new Set(two.slice(200)).size).toBe(200);
    expect(two.slice(200)).toEqual(feed);
  });
  it('the screen\'s memory stays the size of the feed', () => {
    let shown: string[] = [];
    const feed = ['c', 'b', 'a'];
    for (let i = 0; i < 50; i++) shown = remember(shown, nextOnWall(feed, shown)!, feed);
    expect(shown).toHaveLength(3);
    expect(remember(['a', 'gone', 'b'], 'a', ['a', 'b'])).toEqual(['b', 'a']);
  });
});

describe('upload limits as data (rules/photo-limits.json; fixtures/photos/limits; tools/photo_limits.py)', () => {
  const files = readdirSync(join(ROOT, LIMITS_DIR)).filter((f) => f.endsWith('.json')).sort();
  it('the limits are the rules file\'s, and generous enough for the PRD\'s load: 200 uploads in 10 minutes from 20 devices behind one address', () => {
    const rules = readJson<{ upload: unknown; pagePerAddress: unknown; maxPhotosPerEvent: number }>('rules/photo-limits.json');
    expect(PHOTO_LIMITS).toEqual({ upload: rules.upload, pagePerAddress: rules.pagePerAddress, maxPhotosPerEvent: rules.maxPhotosPerEvent });
    expect(PHOTO_LIMITS.upload).toEqual({ perDevice: { limit: 30, windowMinutes: 10 }, perAddress: { limit: 300, windowMinutes: 10 }, perEvent: { limit: 1500, windowMinutes: 60 } });
    expect(asLimit(PHOTO_LIMITS.upload.perDevice)).toEqual({ limit: 30, windowMs: 600_000 });
    const load = expand([{ from: 0, every: 3, count: 200, devices: Array.from({ length: 20 }, (_, i) => `d${i}`), address: 'venue' }]);
    expect(simulate(PHOTO_LIMITS.upload, load).every((o) => o === 'ok')).toBe(true);
    // The page limit leaves room for those 200 uploads, each a page view, a post and the page again.
    expect(PHOTO_LIMITS.pagePerAddress.limit).toBeGreaterThanOrEqual(200 * 3);
  });
  it.each(files)('%s matches the engine', (f) => {
    const text = readFileSync(join(ROOT, LIMITS_DIR, f), 'utf8');
    expect(regenerateLimits(JSON.parse(text) as LimitFx)).toBe(text);
  });
  it('by hand: the 31st upload from one phone inside ten minutes is refused, and the next window starts clean', () => {
    const one = (t: number) => ({ t, device: 'd', address: 'a' });
    const got = simulate(PHOTO_LIMITS.upload, [...Array.from({ length: 31 }, (_, i) => one(i)), one(599), one(600)]);
    expect(got.slice(0, 30).every((o) => o === 'ok')).toBe(true);
    expect(got.slice(30)).toEqual(['device', 'device', 'ok']);
  });
  it('a blocked device is refused before anything is counted', () => {
    const tight = { perDevice: { limit: 1, windowMinutes: 10 }, perAddress: { limit: 1, windowMinutes: 10 }, perEvent: { limit: 5, windowMinutes: 10 } };
    expect(simulate(tight, [{ t: 0, device: 'bad', address: 'a' }, { t: 1, device: 'bad', address: 'a' }, { t: 2, device: 'good', address: 'a' }], ['bad'])).toEqual(['blocked', 'blocked', 'ok']);
  });
  it('the three counters have different keys, and a key carries only hashes and ids', () => {
    const k = limitKeys('event-1', 'hash-1', '203.0.113.9');
    expect(new Set(Object.values(k)).size).toBe(3);
    expect(k).toEqual({ device: 'photo:device:event-1:hash-1', address: 'photo:address:event-1:203.0.113.9', event: 'photo:event:event-1' });
  });
});

describe('the two days of a photo event are derived from the wedding date (rule 1; D-68)', () => {
  it('the link works through the last upload day and not the day after; closed by hand, never', () => {
    const e = { uploadsOpen: true, uploadDays: 7 };
    expect(lastUploadDay('2027-10-09', 7)).toBe('2027-10-16');
    expect(['2026-11-24', '2027-10-09', '2027-10-16', '2027-10-17', '2028-01-01'].map((today) => linkOpen(e, '2027-10-09', today))).toEqual([true, true, true, false, false]);
    expect(linkOpen({ ...e, uploadsOpen: false }, '2027-10-09', '2027-10-09')).toBe(false);
    expect(linkOpen({ uploadsOpen: true, uploadDays: 0 }, '2027-10-09', '2027-10-09')).toBe(true);
    expect(linkOpen({ uploadsOpen: true, uploadDays: 0 }, '2027-10-09', '2027-10-10')).toBe(false);
  });
  it('photos are kept through the last kept day and purged from the day after', () => {
    expect(lastKeptDay('2027-10-09', 365)).toBe('2028-10-08'); // 2028 is a leap year
    expect(['2028-10-07', '2028-10-08', '2028-10-09'].map((today) => purgeDue({ retentionDays: 365 }, '2027-10-09', today))).toEqual([false, false, true]);
  });
  it('move the wedding and both days move with it: nothing was stored to go stale', () => {
    expect([lastUploadDay('2027-11-20', 7), lastKeptDay('2027-11-20', 365)]).toEqual(['2027-11-27', '2028-11-19']);
    expect(linkOpen({ uploadsOpen: true, uploadDays: 7 }, '2027-11-20', '2027-10-17')).toBe(true); // closed under the old date, open under the new
    expect(EVENT_DEFAULTS).toEqual({ uploadDays: 7, retentionDays: 365 });
  });
});

describe('the gallery zip, written here (D-67)', () => {
  const at = { year: 2027, month: 10, day: 12, hour: 9, minute: 30, second: 44 };
  it('CRC-32 is the standard one', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
  it('Python\'s zipfile (an independent reader) opens it, finds every file intact, stored and not compressed', () => {
    const files = [{ name: 'photo-0001.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }, { name: 'photo-0002.jpg', data: new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff) }, { name: 'captions.txt', data: new TextEncoder().encode('file\tfrom\tcaption\nphoto-0001.jpg\tZoë\tfirst dance 💃\n') }, { name: 'empty.bin', data: new Uint8Array(0) }];
    const zip = zipStored(files, at);
    const path = join(mkdtempSync(join(tmpdir(), 'kw-zip-')), 'gallery.zip');
    writeFileSync(path, zip);
    const out = JSON.parse(execFileSync('python3', ['-I', '-c', 'import zipfile,sys,json,hashlib\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"files":[[i.filename,i.file_size,i.compress_size,i.compress_type,hashlib.sha256(z.read(i)).hexdigest(),list(i.date_time)] for i in z.infolist()]}))', path], { encoding: 'utf8' })) as { bad: string | null; files: [string, number, number, number, string, number[]][] };
    expect(out.bad).toBeNull();
    expect(out.files.map((f) => f[0])).toEqual(files.map((f) => f.name));
    for (const [i, f] of files.entries()) {
      expect([out.files[i]![1], out.files[i]![2], out.files[i]![3]]).toEqual([f.data.length, f.data.length, 0]); // method 0: stored
      expect(out.files[i]![4]).toBe(execFileSync('python3', ['-I', '-c', 'import sys,hashlib\nprint(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'], { input: f.data, encoding: 'utf8' }).trim());
      expect(out.files[i]![5]).toEqual([2027, 10, 12, 9, 30, 44]);
    }
    // No compression means the size is exactly the files plus the directory.
    const names = files.reduce((n, f) => n + new TextEncoder().encode(f.name).length, 0);
    expect(zip.length).toBe(files.reduce((n, f) => n + f.data.length, 0) + files.length * (30 + 46) + 2 * names + 22);
  });
  it('an empty archive is valid, the same input gives the same bytes, and two files cannot share a name', () => {
    expect(Buffer.from(zipStored([], at)).toString('hex')).toBe('504b0506' + '00'.repeat(18));
    const f = [{ name: 'a.txt', data: new TextEncoder().encode('a') }];
    expect(Buffer.from(zipStored(f, at)).equals(Buffer.from(zipStored(f, at)))).toBe(true);
    expect(() => zipStored([...f, ...f], at)).toThrow(/same name/);
    expect(() => zipStored(Array.from({ length: 65_536 }, (_, i) => ({ name: String(i), data: new Uint8Array(0) })), at)).toThrow(/65,535/);
  });
});

describe('the guest\'s projection (rule 3) and what a guest may type (D-61\'s rule)', () => {
  it('the upload page is two strings and nothing else', () => {
    const view = uploadView({ wedding: { title: 'Juniper & Rowan', date: '2027-10-09', orgId: 'x' } as never, event: { name: 'Reception', mode: 'pre', uploadTokenHash: 'h', id: 'e' } as never });
    expect(view).toEqual({ weddingTitle: 'Juniper & Rowan', eventName: 'Reception' });
    expect(Object.keys(view)).toEqual(['weddingTitle', 'eventName']);
  });
  it('a name and a caption are optional, trimmed, one plain line each, and bounded', () => {
    expect(checkText({ name: '  Ada  ', caption: ' First dance ' })).toEqual({ ok: true, name: 'Ada', caption: 'First dance' });
    expect(checkText({ name: '', caption: '' })).toEqual({ ok: true, name: '', caption: '' });
    for (const bad of ['line\nbreak', 'tab\there', 'nul\u0000', 'rtl\u202eoverride', 'sep\u2028arator', 'isolate\u2066x', 'c1\u0085']) {
      expect(checkText({ name: 'Ada', caption: bad }), JSON.stringify(bad)).toEqual({ ok: false, code: 'text' });
      expect(checkText({ name: bad, caption: '' }), JSON.stringify(bad)).toEqual({ ok: false, code: 'text' });
    }
    expect(checkText({ name: 'n'.repeat(60), caption: 'c'.repeat(200) }).ok).toBe(true);
    expect(checkText({ name: 'n'.repeat(61), caption: '' })).toEqual({ ok: false, code: 'name' });
    expect(checkText({ name: '', caption: 'c'.repeat(201) })).toEqual({ ok: false, code: 'caption' });
    expect(checkText({ name: 'Zoë 💃', caption: 'Ünïcödé is fine' }).ok).toBe(true);
  });
  it('every refusal a guest can get has a sentence, and only listed codes are shown', () => {
    for (const code of Object.keys(UPLOAD_PROBLEM)) expect(isPhotoProblem(code), code).toBe(true);
    for (const code of ['text', 'name', 'caption', 'busy', 'full', 'refused']) expect(PHOTO_PROBLEM[code as keyof typeof PHOTO_PROBLEM]).toMatch(/\.$/);
    expect([isPhotoProblem('<script>'), isPhotoProblem('constructor'), isPhotoDone('toString'), isPhotoDone('live'), isPhotoDone('pending')]).toEqual([false, false, false, true, true]);
    // A blocked device is told the photo was not added, and nothing about being blocked.
    expect(PHOTO_PROBLEM.refused).not.toMatch(/block|device|ban/i);
  });
});

describe('who may see and moderate photos (the photos_moderate grant)', () => {
  const partner = { role: 'owner', grants: [] };
  const helper = { role: 'member', grants: [] };
  const moderator = { role: 'member', grants: ['photos_moderate' as const] };
  it('partners do everything; a helper needs the grant, which never reaches event settings', () => {
    expect(GRANT_SCOPES).toContain('photos_moderate');
    expect(['photos.view', 'photos.moderate', 'photos.manage'].map((c) => allows(partner, c as never))).toEqual([true, true, true]);
    expect(['photos.view', 'photos.moderate', 'photos.manage'].map((c) => allows(helper, c as never))).toEqual([false, false, false]);
    expect(['photos.view', 'photos.moderate', 'photos.manage'].map((c) => allows(moderator, c as never))).toEqual([true, true, false]);
    // The grant opens nothing else.
    expect(['budget.view', 'vendors.view', 'guests.view', 'gifts.view', 'consent.view', 'helpers.manage'].map((c) => allows(moderator, c as never))).toEqual([false, false, false, false, false, false]);
  });
  it('the activity feed shows photo entries only to those who can see photos, and attachments to those who can see vendors', () => {
    for (const entity of ['photoevent', 'photo', 'photodevice']) expect([canSeeEntity(partner, entity), canSeeEntity(helper, entity), canSeeEntity(moderator, entity)], entity).toEqual([true, false, true]);
    expect([canSeeEntity(partner, 'attachment'), canSeeEntity(helper, 'attachment'), canSeeEntity(moderator, 'attachment'), canSeeEntity({ role: 'member', grants: ['vendors_view'] }, 'attachment')]).toEqual([true, false, false, true]);
  });
});
