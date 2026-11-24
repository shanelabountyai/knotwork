import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './fixtures';

// CLAUDE.md's four build rules as scans, so a later change that breaks one fails here by name.
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const src = globSync('src/**/*.{ts,tsx}', { cwd: ROOT }).filter((f) => !f.startsWith('src/generated/')).sort();
const filesWith = (re: RegExp) => src.filter((f) => re.test(read(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))); // comments do not count

describe('rule 1: all deadlines derive from the anchor (no free-floating dates)', () => {
  const schema = read('prisma/schema/knotwork.prisma');
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, body: m[2]! }));
  const dateFields = models.flatMap((m) => [...m.body.matchAll(/^\s*(\w+)\s+DateTime\??\s+[^\n]*$/gm)].map((f) => `${m.name}.${f[1]}`));

  // Every date or timestamp column in the clone's schema, and why it is not a free-floating deadline.
  const ALLOWED: Record<string, string> = {
    'Wedding.date': 'THE anchor: the one stored deadline',
    'Wedding.createdAt': 'row timestamp', 'Wedding.updatedAt': 'row timestamp',
    'Wedding.pairedAt': 'a date of fact: when two partners were first seen (D-33)',
    'Task.completedOn': 'a date of fact: when it was finished', 'Task.createdAt': 'row timestamp',
    'ScheduleBaseline.fromDate': 'history: the anchor before a move', 'ScheduleBaseline.toDate': 'history: the anchor after a move', 'ScheduleBaseline.createdAt': 'row timestamp',
    'BudgetCategory.createdAt': 'row timestamp',
    'Expense.paidOn': 'a date of fact: when the money went out', 'Expense.createdAt': 'row timestamp',
    'BudgetSnapshot.takenAt': 'row timestamp',
    'Vendor.contractSignedOn': 'a date of fact: when both approved the contract', 'Vendor.createdAt': 'row timestamp',
    'VendorPayment.paidOn': 'a date of fact', 'VendorPayment.createdAt': 'row timestamp',
    'VendorFlag.raisedAt': 'row timestamp', 'VendorFlag.ackAt': 'a date of fact: when it was acknowledged',
    'VendorBrief.generatedAt': 'row timestamp',
    'ConsentRequest.proposedAt': 'row timestamp', 'ConsentRequest.expiresAt': 'when the request lapses: proposedAt + consentExpiryDays, not a plan deadline',
    'ConsentRequest.decidedAt': 'a date of fact', 'ConsentRequest.executedAt': 'a date of fact',
    'HelperGrant.createdAt': 'row timestamp',
    'GuestPlan.updatedAt': 'row timestamp',
    'Household.invitedOn': 'a date of fact: when the invitation was released (never guest-facing, rule 3)', 'Household.saveTheDateSentOn': 'a date of fact', 'Household.createdAt': 'row timestamp',
    'Guest.respondedAt': 'a date of fact', 'Guest.removedAt': 'a date of fact: when both approved the removal', 'Guest.createdAt': 'row timestamp',
    'InviteWave.releasedAt': 'a date of fact', 'HeadcountDelta.at': 'row timestamp', 'ChaseEvent.at': 'a date of fact: when the reminder went or the call was made',
    'DoNotPlay.createdAt': 'row timestamp',
    'RegistryItem.fundedOn': 'a date of fact: the day the pot reached its target', 'RegistryItem.closedOn': 'a date of fact: the day the registry was closed with the gift unfunded',
    'RegistryItem.createdAt': 'row timestamp', 'GiftEntry.createdAt': 'row timestamp: when the entry was written (the ledger is append-only)',
    'ThankYou.createdAt': 'row timestamp: when the thank-you became owed', 'ThankYou.acknowledgedOn': 'a date of fact: when a partner marked it as sent',
    // Phase 3, photos. When an upload link stops and when photos are purged are NOT here: both are derived from
    // Wedding.date (PhotoEvent.uploadDays, PhotoEvent.retentionDays are whole numbers of days, like Task.bufferDays).
    'PhotoEvent.createdAt': 'row timestamp', 'PhotoDevice.createdAt': 'row timestamp: when the device first added a photo',
    'PhotoDevice.blockedAt': 'a date of fact: when a moderator blocked the device', 'Photo.createdAt': 'row timestamp: when the photo was stored',
    'Photo.purgedAt': 'a date of fact: when the retention purge deleted its bytes (the day it falls due is derived, never stored)',
    'VendorAttachment.createdAt': 'row timestamp',
    // Phase 4. P1-1 adds no date: a reveal point is Task/Expense/Vendor/BudgetCategory.revealDays, a whole number of days
    // from Wedding.date (D-92). P1-2: the day money arrived is a date of fact.
    'Funder.createdAt': 'row timestamp', 'FunderPledge.createdAt': 'row timestamp', 'FunderAllocation.createdAt': 'row timestamp: when the payment from the pledge was recorded',
    'FunderReceipt.receivedOn': 'a date of fact: the day the money arrived', 'FunderReceipt.createdAt': 'row timestamp',
  };

  it('finds the clone\'s thirty-two models', () => {
    expect(models.map((m) => m.name)).toHaveLength(32); // twenty from Phases 1 and 2, three for gifting, five for photos and attachments, four for funding (P1-2)
  });
  it('a photo event stores day counts, and both of its days are worked out from the wedding date', () => {
    const event = models.find((m) => m.name === 'PhotoEvent')!.body;
    expect(event).toMatch(/uploadDays\s+Int/);
    expect(event).toMatch(/retentionDays\s+Int/);
    expect(dateFields.filter((f) => f.startsWith('PhotoEvent.'))).toEqual(['PhotoEvent.createdAt']);
    const dates = read('src/lib/knotwork/photos/dates.ts');
    expect(dates).toMatch(/lastUploadDay = \(weddingDate: Day, uploadDays: number\): Day => addDays\(weddingDate, uploadDays\)/);
    expect(dates).toMatch(/lastKeptDay = \(weddingDate: Day, retentionDays: number\): Day => addDays\(weddingDate, retentionDays\)/);
  });
  it('every date column is on the list with its reason; a new one fails until someone decides what it is', () => {
    expect(dateFields.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
  it('Task has no date of its own except the day it was finished', () => {
    expect(dateFields.filter((f) => f.startsWith('Task.'))).toEqual(['Task.completedOn', 'Task.createdAt']);
    expect(models.find((m) => m.name === 'Task')!.body).toMatch(/leadDays\s+Int/);
    expect(models.find((m) => m.name === 'Task')!.body).toMatch(/bufferDays\s+Int/);
  });
  it('no column is named like a deadline', () => {
    const names = models.flatMap((m) => [...m.body.matchAll(/^\s*(\w+)\s+\w+/gm)].map((f) => f[1]!));
    expect(names.filter((n) => /^due(?!Days)|deadline|startBy|dueDate|dueOn/i.test(n))).toEqual([]);
  });
  it('a vendor payment is "N days before", never a date', () => {
    expect(models.find((m) => m.name === 'VendorPayment')!.body).toMatch(/dueDaysBefore\s+Int/);
  });
});

describe('rule 2: designated actions only through the consent module', () => {
  const EXECUTE = 'src/lib/knotwork/consent/execute.ts';

  it('only the executor (and the atomic move it calls) writes the wedding row after creation', () => {
    // The pairing latch (D-33) is not written by any file: the database sets it (D-56).
    expect(filesWith(/\.wedding\.(update|updateMany|upsert|delete|deleteMany)\(/)).toEqual([EXECUTE, 'src/lib/knotwork/schedule/store.ts']);
    expect(filesWith(/pairedAt:/)).toEqual([]);
    expect(read('src/lib/knotwork/schedule/store.ts').match(/\.wedding\.update\(/g)).toHaveLength(1); // inside commitMove
    expect(filesWith(/\bcommitMove\(/)).toEqual([EXECUTE, 'src/lib/knotwork/schedule/store.ts']); // defined in the store, called only by the executor
  });
  it('only the executor books a vendor or signs a contract', () => {
    expect(filesWith(/bookedRequestId:\s*(?!true)/)).toEqual([EXECUTE]);
    expect(filesWith(/contractRequestId:\s*(?!true)/)).toEqual([EXECUTE]);
    expect(filesWith(/data:\s*\{[^}]*contractSignedOn/)).toEqual([EXECUTE]); // elsewhere it is only read (the brief, the pages)
    expect(read('src/lib/knotwork/vendors/store.ts')).not.toMatch(/status:\s*'booked'/);
    // The two files besides the executor that say status: 'booked' only read it: syncRsvpTask in the schedule store, and
    // the on-site vendor count in the guest store. (Review 2026-11-24, M4: this list had been replaced by the narrower
    // `data: {…}` check below, which a write built in a variable would slip past. Both checks now hold.)
    const READS_BOOKED = ['src/lib/knotwork/guests/store.ts', 'src/lib/knotwork/schedule/store.ts'];
    expect(filesWith(/status:\s*'booked'/).filter((f) => !/vendors\/(scope|store)\.ts$/.test(f))).toEqual([EXECUTE, ...READS_BOOKED]);
    for (const f of READS_BOOKED) expect(read(f).match(/status:\s*'booked'/g)).toHaveLength(1);
    expect(read('src/lib/knotwork/guests/store.ts')).toMatch(/tx\.vendor\.count\(\{ where: \{ \.\.\.inOrg\(ctx\), status: 'booked', onSite: true \} \}\)/);
    expect(read('src/lib/knotwork/guests/store.ts')).not.toMatch(/\.vendor\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(filesWith(/data:\s*\{[^}]*status:\s*'booked'/)).toEqual([EXECUTE]);
  });
  it('only the executor removes a guest, and nothing ever deletes a guest or a household', () => {
    expect(filesWith(/data:\s*\{[^}]*removedAt/)).toEqual([EXECUTE]);
    expect(filesWith(/removedRequestId:\s*(?!true)/)).toEqual([EXECUTE]);
    expect(filesWith(/\.(guest|household)\.(delete|deleteMany)\(/)).toEqual([]);
    const sql = read('prisma/migrations/20261124000001_knotwork_phase2/migration.sql');
    for (const t of ['Guest_guard', 'Household_guard']) expect(sql).toContain(`CREATE TRIGGER "${t}"`);
  });
  it('only the budget store creates an expense, and it refuses one over the threshold without a request', () => {
    expect(filesWith(/\.expense\.(create|createMany|update|updateMany|upsert)\(/)).toEqual(['src/lib/knotwork/budget-store.ts']);
    expect(read('src/lib/knotwork/budget-store.ts')).toMatch(/spendNeedsConsent\(input\.amountCents, wedding\.spendThresholdCents\) && !requestId\) throw/);
  });
  it('only the consent store marks a request approved, and only it calls the executor', () => {
    expect(filesWith(/status:\s*'approved'/)).toEqual(['src/lib/knotwork/consent/store.ts']);
    expect(filesWith(/\bexecuteApproved\(/)).toEqual([EXECUTE, 'src/lib/knotwork/consent/store.ts']);
    expect(filesWith(/\.consentRequest\.(update|updateMany|delete|deleteMany|upsert)\(/)).toEqual(['src/lib/knotwork/consent/store.ts']);
  });
  it('the actions file never imports the executor or the atomic move', () => {
    const actions = read('src/app/o/[org]/wedding/actions.ts').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''); // comments do not count
    expect(actions).not.toMatch(/consent\/execute/);
    expect(actions).not.toMatch(/\bcommitMove\b/);
    expect(actions).not.toMatch(/\bcreateExpense\b(?!,| ,|\(tx, ctx, wedding, input, null\))/); // only the under-threshold call, with no request
  });
  it('the migration carries the database half: four guard triggers and the two-key check', () => {
    const sql = read('prisma/migrations/20261123000001_knotwork_phase1/migration.sql');
    for (const t of ['ConsentRequest_guard', 'Vendor_guard', 'Wedding_guard', 'Expense_guard']) expect(sql).toContain(`CREATE TRIGGER "${t}"`);
    const solo = read('prisma/migrations/20261124000000_knotwork_solo/migration.sql');
    for (const t of ['ConsentRequest_insert_guard', 'Wedding_paired_guard']) expect(solo).toContain(`CREATE TRIGGER "${t}"`);
    expect(sql).toContain('"deciderId" <> "proposerId"');
  });
});

// Until Phase 3 this block was one test, "rules 3 and 4 have nothing to guard yet": no public Knotwork route and no
// file input anywhere. Both now exist on purpose (the RSVP and gift pages since Phase 2; the photo link and contract
// attachments in Phase 3), so the blanket "none" is replaced by closed lists: exactly which routes are guest-facing,
// and exactly which files may touch an uploaded file. Anything outside either list fails here by name.
describe('rule 3: the guest-facing surfaces are a closed list', () => {
  const strip = (text: string) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const GUEST_FACING = ['src/app/p/[token]/page.tsx', 'src/app/p/[token]/upload/route.ts', 'src/app/r/[token]/gifts/contribute/route.ts', 'src/app/r/[token]/gifts/page.tsx', 'src/app/r/[token]/page.tsx', 'src/app/r/[token]/respond/route.ts'];

  it('the public Knotwork routes are exactly /r/[token] (+ respond, gifts, gifts/contribute) and /p/[token] (+ upload)', () => {
    const routes = globSync('src/app/**/{page,route}.{ts,tsx}', { cwd: ROOT }).sort();
    const isPublic = (f: string) => /^\/\/ public: \S/m.test(read(f));
    expect(routes.filter((f) => /^src\/app\/(r|p)\//.test(f))).toEqual(GUEST_FACING);
    for (const f of GUEST_FACING) expect(isPublic(f), f).toBe(true);
    // Nothing under the signed-in tree is public, whatever it is called.
    expect(routes.filter((f) => f.startsWith('src/app/o/') && isPublic(f))).toEqual([]);
    expect(routes.filter((f) => /^src\/app\/(o|r|p)\//.test(f) && isPublic(f))).toEqual(GUEST_FACING);
  });
  it('the photo link\'s two files touch no database and no store: only photos/public.ts, which shows only the projection', () => {
    for (const f of GUEST_FACING.slice(0, 2)) expect(strip(read(f)), f).not.toMatch(/@\/core\/db|photos\/(store|blobs|qr)|guests\/(store|public)|gifts\/|\btx\b|withOrg|asSystem/);
    expect([...read('src/app/p/[token]/page.tsx').matchAll(/from '@\/lib\/knotwork\/([\w/-]+)'/g)].map((m) => m[1]!)).toEqual(['photos/projection', 'photos/public']);
    // The guest's whole view is two strings. No list, wave, date, guest or household exists in the shape.
    const projection = strip(read('src/lib/knotwork/photos/projection.ts'));
    expect(projection).toMatch(/export type UploadView = \{ weddingTitle: string; eventName: string \};/);
    expect(projection).not.toMatch(/\b(list|wave\w*|priority|invitedOn|createdAt|household\w*|guest\w*|date)\b/i);
    const pub = strip(read('src/lib/knotwork/photos/public.ts'));
    expect(pub).toMatch(/Promise<UploadView \| 'limited' \| null>/);
    expect(pub).not.toMatch(/\.(household|guest|inviteWave|guestPlan|giftEntry|registryItem)\./);
  });
  it('the only two Knotwork files that read across orgs are the two token lookups', () => {
    expect(filesWith(/\basSystem\s*\(/).filter((f) => f.includes('knotwork') || /^src\/app\/(o|r|p)\//.test(f))).toEqual(['src/lib/knotwork/guests/public.ts', 'src/lib/knotwork/photos/public.ts']);
  });
  it('/p/:path* carries the same three headers as /r/:path* (the token is in the URL)', () => {
    const config = read('next.config.ts');
    for (const source of ['/r/:path*', '/p/:path*']) {
      const block = config.slice(config.indexOf(`source: '${source}'`)).split('},\n    //')[0]!;
      expect(block, source).toContain(`{ key: 'Referrer-Policy', value: 'no-referrer' }`);
      expect(block, source).toContain(`{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }`);
      expect(block, source).toContain(`{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }`);
    }
  });
});

describe('rule 4: uploads are hostile input: one pipeline, and nothing else reads a file', () => {
  const strip = (text: string) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const READ = 'src/lib/knotwork/uploads/read.ts';
  const PROCESS = 'src/lib/knotwork/uploads/process.ts';
  const UPLOAD_ROUTES = ['src/app/o/[org]/wedding/vendors/[id]/attachments/route.ts', 'src/app/p/[token]/upload/route.ts'];
  const FORMS = ['src/app/o/[org]/wedding/vendors/[id]/page.tsx', 'src/app/p/[token]/page.tsx'];
  // Knotwork's own code: the library, and everything served under /o, /r and /p.
  const ours = (files: string[]) => files.filter((f) => /^src\/(lib\/knotwork|app\/(o\/\[org\]\/wedding|r|p))\//.test(f));

  it('only uploads/read.ts takes a file, or raw bytes, out of a request', () => {
    expect(ours(filesWith(/\.arrayBuffer\(\)|\.blob\(\)|\.bytes\(\)|\breq(uest)?\.body\b|getReader\(|\bFile\b|\bBlob\b/))).toEqual([READ]);
    // formData() elsewhere is the two plain-text guest forms from Phase 2, which keep only strings.
    const TEXT_FORMS = ['src/app/r/[token]/gifts/contribute/route.ts', 'src/app/r/[token]/respond/route.ts'];
    expect(ours(filesWith(/\.formData\(\)/))).toEqual([...TEXT_FORMS, READ]);
    for (const f of TEXT_FORMS) {
      expect(strip(read(f)).match(/form\.get(All)?\(/g)!.length, f).toBeGreaterThan(0);
      expect(strip(read(f)), f).toMatch(/typeof form\.get\(k\) === 'string'/);
      expect(strip(read(f)), f).not.toMatch(/as (File|Blob)|instanceof/);
    }
  });
  it('a file input exists on exactly two forms, each posting multipart to its own upload route', () => {
    expect(filesWith(/type="file"/)).toEqual(FORMS);
    expect(filesWith(/multipart\/form-data/)).toEqual(FORMS);
    expect(read(READ)).toContain(String.raw`if (!/^multipart\/form-data\b/i.test(type)) return { ok: false, code: 'empty', text: none };`);
    expect(read(FORMS[0]!)).toMatch(/<form method="post" action=\{attachBase\} encType="multipart\/form-data">/);
    expect(read(FORMS[0]!)).toMatch(/const attachBase = `\/o\/\$\{ctx\.slug\}\/wedding\/vendors\/\$\{x\.id\}\/attachments`;/);
    expect(read(FORMS[1]!)).toMatch(/<form method="post" action=\{`\/p\/\$\{token\}\/upload`\} encType="multipart\/form-data">/);
    for (const f of FORMS) expect(read(f), f).toMatch(/accept="image\/jpeg,image\/png,image\/webp"/);
  });
  it('every upload route calls the pipeline, never reads the body itself, and nothing else calls it', () => {
    expect(filesWith(/\breceiveImage\(/)).toEqual([...UPLOAD_ROUTES, READ]);
    expect(filesWith(/\bprocessUpload\(/)).toEqual([PROCESS, READ]);
    for (const f of UPLOAD_ROUTES) {
      const text = strip(read(f));
      expect(text.match(/await receiveImage\(req, /g), f).toHaveLength(1);
      expect(text, f).not.toMatch(/formData|arrayBuffer|\.body\b|\.text\(\)|\.json\(\)|\.blob\(\)|\.bytes\b|Uint8Array|Buffer/);
      expect(text, f).toMatch(/got\.image\b/); // what is stored is what the pipeline returned
    }
    // A route under the signed-in tree that takes a POST and is not on the list would be a second way in.
    const posts = globSync('src/app/{o,r,p}/**/route.{ts,tsx}', { cwd: ROOT }).sort().filter((f) => /export async function POST\b/.test(read(f)));
    expect(posts).toEqual([UPLOAD_ROUTES[0]!, UPLOAD_ROUTES[1]!, 'src/app/r/[token]/gifts/contribute/route.ts', 'src/app/r/[token]/respond/route.ts']);
  });
  it('the pipeline is sniff, cap, decode, re-encode, inspect: in that order, in one function', () => {
    const text = strip(read(PROCESS));
    const order = ['precheck(raw)', 'limitInputPixels: MAX_PIXELS', '.rotate()', '.jpeg(JPEG)', 'every(clean)'].map((needle) => text.indexOf(needle));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    const body = text.slice(text.indexOf('export async function processUpload'));
    expect(['precheck(raw)', 'open().metadata()', 'upright()', 'every(clean)', 'ok: true'].map((n) => body.indexOf(n))).toEqual([...['precheck(raw)', 'open().metadata()', 'upright()', 'every(clean)', 'ok: true'].map((n) => body.indexOf(n))].sort((a, b) => a - b));
    expect(text).toMatch(/inspect\(r\.bytes\)\.length > 0\) return false/); // one finding in the OUTPUT fails the ingest
    expect(text).toMatch(/failOn: 'error', animated: false, pages: 1/);
    // The allowlist is by magic bytes: sniff takes bytes and nothing else, and no upload code reads a name or a declared type.
    expect(strip(read('src/lib/knotwork/uploads/sniff.ts'))).toMatch(/export function sniff\(b: Uint8Array\): ImageType \| null/);
    for (const f of [READ, PROCESS, ...UPLOAD_ROUTES]) expect(strip(read(f)), f).not.toMatch(/file\.(name|type)\b|\.mimetype|\.filename/);
    // The byte cap is applied while reading: the reader stops, and cancels, as soon as the total passes it.
    expect(strip(read(READ))).toMatch(/total \+= value\.byteLength;\s+if \(total > cap\) \{\s+await reader\.cancel\(\)/);
  });
  it('sharp is imported by the pipeline alone, and is never asked to keep or write metadata', () => {
    expect(filesWith(/from 'sharp'/)).toEqual([PROCESS]);
    expect(filesWith(/withMetadata|keepMetadata|keepExif|keepIccProfile|keepXmp|withExif|withExifMerge|withIccProfile|withXmp/)).toEqual([]);
  });
  it('nothing stores raw request bytes: a bytes column takes only a Processed image, which only the pipeline can make', () => {
    const schema = read('prisma/schema/knotwork.prisma');
    const bytes = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].flatMap((m) => [...m[2]!.matchAll(/^\s*(\w+)\s+Bytes\??\s/gm)].map((f) => `${m[1]}.${f[1]}`));
    expect(bytes).toEqual(['PhotoBlob.bytes', 'VendorAttachment.bytes']);
    const BLOBS = 'src/lib/knotwork/photos/blobs.ts';
    const ATTACHMENTS = 'src/lib/knotwork/vendors/attachments.ts';
    expect(filesWith(/\.photoBlob\.(create|createMany|createManyAndReturn|update|updateMany|upsert)\(/)).toEqual([BLOBS]);
    expect(filesWith(/\.vendorAttachment\.(create|createMany|createManyAndReturn|update|updateMany|upsert)\(/)).toEqual([ATTACHMENTS]);
    expect(filesWith(/\$executeRaw|\$queryRaw/).filter((f) => /photos|uploads|attachments/.test(f))).toEqual([]);
    // Each writer's bytes come from its `image: Processed` argument and from nowhere else.
    expect(strip(read(BLOBS))).toMatch(/export async function writeBlobs\(tx: Tx, orgId: string, photoId: string, image: Processed\)/);
    expect(strip(read(BLOBS)).match(/bytes:/g)).toHaveLength(2); // the write (from image.renditions[kind]) and the read's select
    expect(strip(read(BLOBS))).toMatch(/const r = image\.renditions\[kind\];\s+await tx\.photoBlob\.create\(\{ data: \{ orgId, photoId, kind, bytes: new Uint8Array\(r\.bytes\)/);
    expect(strip(read(ATTACHMENTS))).toMatch(/export async function addAttachment\(tx: Tx, ctx: Ctx, vendorId: string, label: string, image: Processed\)/);
    expect(strip(read(ATTACHMENTS))).toMatch(/const full = image\.renditions\.full;/);
    expect(strip(read(ATTACHMENTS))).toMatch(/bytes: new Uint8Array\(full\.bytes\)/);
    for (const f of [BLOBS, ATTACHMENTS]) expect(strip(read(f)), f).not.toMatch(/Request|formData|uploads\/read/);
    // `Processed` carries a symbol key that is not exported, so no other file can construct one.
    const process = strip(read(PROCESS));
    expect(process).toMatch(/^const PROCESSED: unique symbol = Symbol\(/m);
    expect(process).not.toMatch(/export (const|\{)[^;]*\bPROCESSED\b/);
    expect(process).toMatch(/readonly \[PROCESSED\]: true/);
    expect(filesWith(/as (unknown as )?Processed\b/)).toEqual([]);
    // The pipeline itself has no database to write to.
    for (const f of src.filter((x) => x.startsWith('src/lib/knotwork/uploads/'))) expect(strip(read(f)), f).not.toMatch(/@\/core\/db|\btx\b|prisma/i);
  });
  it('the database holds its half: only a JPEG of its true length, inside the cap and the rendition\'s box', () => {
    const sql = read('prisma/migrations/20261125000002_knotwork_photos/migration.sql');
    for (const c of ['Photo_mime_check', 'PhotoBlob_bytes_check', 'PhotoBlob_box_check', 'VendorAttachment_bytes_check', 'VendorAttachment_box_check']) expect(sql).toContain(`ADD CONSTRAINT "${c}"`);
    for (const t of ['PhotoDevice_guard', 'Photo_guard', 'PhotoBlob_guard', 'Photo_purge_guard', 'VendorAttachment_guard']) expect(sql).toContain(`CREATE TRIGGER "${t}"`);
    expect(sql).toContain(`substring("bytes" from 1 for 3) = '\\xffd8ff'::bytea AND "size" = octet_length("bytes") AND "size" <= 10485760`);
  });
  it('each guard has its fixture: the allowlist, both caps, and every kind of metadata', () => {
    const manifest = JSON.parse(read('fixtures/photos/strip/manifest.json')) as { cases: { expect: { result: string; before: string[]; after?: string[] } }[] };
    const results = new Set(manifest.cases.map((c) => c.expect.result));
    for (const code of ['ok', 'type', 'pdf', 'too-big', 'pixels', 'animated', 'unreadable', 'empty']) expect(results.has(code), code).toBe(true);
    const found = new Set(manifest.cases.flatMap((c) => c.expect.before));
    for (const kind of ['exif', 'gps', 'xmp', 'icc', 'iptc', 'comment', 'text', 'time', 'trailing']) expect(found.has(kind), kind).toBe(true);
    for (const c of manifest.cases.filter((x) => x.expect.result === 'ok')) expect(c.expect.after).toEqual([]);
  });
});

describe('P0-5 privacy: the couple\'s side never reads what one household gave', () => {
  const strip = (text: string) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''); // comments do not count
  const COUPLE_LOADER = 'src/lib/knotwork/gifts/couple.ts';
  const couplePages = globSync('src/app/o/**/*.{ts,tsx}', { cwd: ROOT }).sort();
  const giftPages = couplePages.filter((f) => f.includes('/wedding/gifts/'));
  // Everything signed-in people are served from, plus the data export: every file but the one loader.
  const coupleSide = [...couplePages, 'src/app/export-hooks.ts'];

  it('finds the couple\'s gift pages and actions', () => {
    expect(giftPages).toEqual(['actions.ts', 'nav.tsx', 'page.tsx', '[id]/page.tsx', 'thank-yous/page.tsx'].map((f) => `src/app/o/[org]/wedding/gifts/${f}`).sort());
  });
  it('no page, action or export hook on the couple\'s side names a ledger entry or its amount', () => {
    for (const f of [...giftPages, 'src/app/export-hooks.ts']) expect(strip(read(f)), f).not.toMatch(/amountCents/);
    for (const f of coupleSide) expect(strip(read(f)), f).not.toMatch(/\bgiftEntry\b|\bGiftEntry\w*\b(?!:)|gifts\/(public|projection)|\bnetByHousehold\b|\bcontributorsOf\b|\bpotCents\b/);
    // The export hook hands over what the couple\'s loader builds, and skips the ledger by name.
    expect(read('src/app/export-hooks.ts')).toMatch(/whole\('RegistryItem', \(tx, orgId\) => exportRegistry\(tx, orgId\)\)/);
    expect(read('src/app/export-hooks.ts')).toMatch(/^  GiftEntry: '/m);
  });
  it('the couple\'s pages reach the ledger only through the loader, and the store hands back no amount', () => {
    const imports = giftPages.flatMap((f) => [...read(f).matchAll(/from '@\/lib\/knotwork\/gifts\/([\w-]+)'/g)].map((m) => m[1]!));
    expect([...new Set(imports)].sort()).toEqual(['couple', 'ledger', 'store']);
    // From the ledger file the actions take two constants (the bounds), and from the store four writes.
    expect(read('src/app/o/[org]/wedding/gifts/actions.ts')).toMatch(/import \{ GIFT_MIN_CENTS, TARGET_MAX_CENTS \} from '@\/lib\/knotwork\/gifts\/ledger';/);
    expect(giftPages.filter((f) => /gifts\/(ledger|store)'/.test(read(f)))).toEqual(['src/app/o/[org]/wedding/gifts/actions.ts']);
    const store = strip(read('src/lib/knotwork/gifts/store.ts'));
    expect([...store.matchAll(/^export (?:async function|type|const) (\w+)/gm)].map((m) => m[1]!).sort()).toEqual(['Contributed', 'ItemInput', 'acknowledgeThankYou', 'addItem', 'closeRegistry', 'contribute', 'updateItem']);
    expect(store).toMatch(/export type Contributed = \{ ok: true; returned: boolean; funded: boolean \} \| \{ ok: false; code: RefusalCode \| 'not-here' \};/);
    expect(store).toMatch(/export async function closeRegistry\(tx: Tx, ctx: Ctx\): Promise<number>/);
  });
  it('the loader reads the ledger in exactly two shapes: a sum per item, and distinct (item, household) pairs with only a name', () => {
    const loader = strip(read(COUPLE_LOADER));
    expect(loader.match(/amountCents/g)).toHaveLength(2); // the aggregate, and reading its result
    expect(loader).toMatch(/tx\.giftEntry\.groupBy\(\{ by: \['itemId'\], where: \{ orgId \}, _sum: \{ amountCents: true \} \}\)/);
    expect(loader).toMatch(/s\._sum\.amountCents \?\? 0/);
    expect(loader).toMatch(/tx\.giftEntry\.findMany\(\{ where: \{ orgId \}, distinct: \['itemId', 'householdId'\], select: \{ itemId: true, household: \{ select: \{ name: true \} \} \} \}\)/);
    expect(loader.match(/\.giftEntry\./g)).toHaveLength(2);
    expect(loader).not.toMatch(/householdId'\][^)]*_sum|\$queryRaw|\$executeRaw|include:\s*\{[^}]*entries|entries:\s*(true|\{)/); // no per-household sum, no raw SQL, no entries pulled through an item
    expect(loader).not.toMatch(/gifts\/(public|projection|store)|\.\/(public|projection|store|ledger)'/);
  });
  it('no other file on the couple\'s side pulls entries through a relation', () => {
    for (const f of [...coupleSide, COUPLE_LOADER]) expect(strip(read(f)), f).not.toMatch(/registryItem\.[a-zA-Z]+\(\{[^;]*\bentries\b/);
    // The thank-you list is rows of (household, item, dates): the table has no amount column at all.
    const thankYou = /^model ThankYou \{([\s\S]*?)^\}/m.exec(read('prisma/schema/knotwork.prisma'))![1]!;
    expect(thankYou).not.toMatch(/Cents|amount/i);
  });
  it('only the ledger\'s engine and the guest\'s own page ever select an entry\'s amount (Expense.amountCents is the budget\'s, another table)', () => {
    expect(filesWith(/amountCents/).filter((f) => /gift|\/r\//.test(f))).toEqual(['src/lib/knotwork/gifts/couple.ts', 'src/lib/knotwork/gifts/ledger.ts', 'src/lib/knotwork/gifts/projection.ts', 'src/lib/knotwork/gifts/public.ts', 'src/lib/knotwork/gifts/store.ts']);
    expect(filesWith(/\.giftEntry\./)).toEqual(['src/lib/knotwork/gifts/couple.ts', 'src/lib/knotwork/gifts/public.ts', 'src/lib/knotwork/gifts/store.ts']);
    // A change-log line is written with logChange; none in the gift store is handed an amount.
    const store = strip(read('src/lib/knotwork/gifts/store.ts'));
    const logged = [...store.matchAll(/logChange\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(logged.length).toBeGreaterThanOrEqual(7);
    for (const call of logged.filter((x) => !/'registry', '(created|updated)'/.test(x))) expect(call).not.toMatch(/Cents|\.\.\.input|line\b|plan\b|refunds\[|\br\./);
    expect(store).toMatch(/logChange\(tx, ctx, 'gift', 'contributed', item\.id, `\$\{household\.name\} gave toward \$\{item\.title\}`, null, \{ household: household\.name, item: item\.title \}, \{ via: 'gift-link' \}\);/);
  });
  it('the ledger is append-only in the database, and the guest page has its own two guest-facing files', () => {
    const sql = read('prisma/migrations/20261125000000_knotwork_gifts/migration.sql');
    for (const t of ['GiftEntry_append_only', 'GiftEntry_guard']) expect(sql).toContain(`CREATE TRIGGER "${t}"`);
    for (const t of ['GiftEntry_pot_check', 'RegistryItem_pot_check']) expect(sql).toContain(`CREATE CONSTRAINT TRIGGER "${t}"`);
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "GiftEntry"');
    for (const c of ['RegistryItem_target_check', 'GiftEntry_sign_check']) expect(sql).toContain(`ADD CONSTRAINT "${c}"`);
    // Rule 3: the gift page and its route are built from gifts/public.ts, which is built from gifts/projection.ts.
    const guestFacing = globSync('src/app/r/**/*.{ts,tsx}', { cwd: ROOT }).sort();
    expect(guestFacing).toEqual(['src/app/r/[token]/gifts/contribute/route.ts', 'src/app/r/[token]/gifts/page.tsx', 'src/app/r/[token]/page.tsx', 'src/app/r/[token]/respond/route.ts']);
    for (const f of guestFacing) {
      expect(read(f), f).toMatch(/^\/\/ public: \S/m);
      expect(strip(read(f)), f).not.toMatch(/@\/core\/db|gifts\/(couple|store)|guests\/store|\btx\b|withOrg|asSystem/);
    }
    expect(strip(read('src/lib/knotwork/gifts/public.ts'))).not.toMatch(/asSystem|gifts\/couple|\.\/couple/);
    expect(strip(read('src/lib/knotwork/gifts/projection.ts'))).not.toMatch(/\b(list|wave\w*|priority|invitedOn|createdAt)\b/); // the words do not occur in the guest's shape at all
  });
});

// Phase 4, P1-1 (ADR-001): the other partner's view, and every helper's, passes through ONE masking function.
describe('P1-1 secrecy: every view of a task, expense, vendor or category passes through the lens', () => {
  const strip = (text: string) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const LENS = 'src/lib/knotwork/secrecy/lens.ts';
  const VIEWS = 'src/lib/knotwork/secrecy/views.ts';
  // Knotwork's signed-in entry points: the workspace home and everything under /wedding (pages and route handlers).
  const entry = src.filter((f) => /^src\/app\/o\/\[org\]\/(page\.tsx|wedding\/(.+\/)?(page|route)\.tsx?)$/.test(f));
  const READS = /\.(task|vendor|expense|budgetCategory|vendorPayment|vendorFlag|vendorBrief|vendorAttachment|budgetSnapshot|scheduleBaseline|funder|funderPledge|funderReceipt|funderAllocation)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\(|\b(loadSchedule|loadTasks|loadBudget|changeLog|previewDateMove|listAttachments|readAttachment|briefInput|fundingByCategory)\(/;

  it('no signed-in page or route reads those tables, the schedule, the budget or the change log itself', () => {
    expect(entry.length).toBeGreaterThanOrEqual(30);
    expect(entry.filter((f) => READS.test(strip(read(f))))).toEqual([]);
  });
  it('the pages that show them read them from secrecy/views.ts (or, for funding, funding/store.ts fundingView)', () => {
    const want: Record<string, RegExp> = {
      'src/app/o/[org]/page.tsx': /overviewView\(/, 'src/app/o/[org]/wedding/schedule/page.tsx': /scheduleView\(/, 'src/app/o/[org]/wedding/budget/page.tsx': /budgetView\(/,
      'src/app/o/[org]/wedding/vendors/page.tsx': /vendorsView\(/, 'src/app/o/[org]/wedding/vendors/[id]/page.tsx': /vendorView\(/, 'src/app/o/[org]/wedding/flags/page.tsx': /flagsView\(/,
      'src/app/o/[org]/wedding/activity/page.tsx': /activityView\(/, 'src/app/o/[org]/wedding/approvals/page.tsx': /movePreview\(/, 'src/app/o/[org]/wedding/date/page.tsx': /movePreview\(/,
      'src/app/o/[org]/wedding/funding/page.tsx': /fundingView\(/, 'src/app/o/[org]/wedding/vendors/[id]/attachments/[attachment]/route.ts': /attachmentFile\(/,
      'src/app/o/[org]/wedding/vendors/[id]/attachments/route.ts': /vendorVisible\(/,
    };
    for (const [f, re] of Object.entries(want)) expect(strip(read(f)), f).toMatch(re);
  });
  it('every loader in views.ts builds its answer with lens(); the funding reader does too', () => {
    const views = strip(read(VIEWS));
    const loaders = [...views.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]!);
    expect(loaders.sort()).toEqual(['activityView', 'attachmentFile', 'budgetView', 'flagsView', 'fundingOptions', 'movePreview', 'overviewView', 'scheduleView', 'vendorView', 'vendorVisible', 'vendorsView']);
    for (const name of loaders) {
      const body = views.slice(views.indexOf(`export async function ${name}(`)).split(/\nexport /)[0]!;
      expect(body, name).toMatch(/lens\(|flagsView\(|vendorVisible\(/); // overview reuses flagsView; attachmentFile reuses vendorVisible
    }
    const fundingView = strip(read('src/lib/knotwork/funding/store.ts')).split('export async function fundingView(')[1]!.split(/\nexport /)[0]!;
    expect(fundingView).toMatch(/const L = lens\(seen\);/);
    expect(fundingView).toMatch(/L\.ofCategory</);
    expect(fundingView).toMatch(/L\.expense\(/);
  });
  it('lens.ts is the only maker of a masked line, and it is pure', () => {
    expect(filesWith(/hidden: true/)).toEqual([LENS]);
    expect([...read(LENS).matchAll(/from '([^']+)'/g)].map((m) => m[1]).every((i) => i!.startsWith('.'))).toBe(true);
  });
  it('the change log is masked at write: logChange asks sealedNow before every entry', () => {
    const log = strip(read('src/lib/knotwork/changelog.ts'));
    expect(log).toMatch(/\(await sealedNow\(tx, ctx\.orgId, entity, id\)\)\s+\? \{ label: PRIVATE_ENTRY, before: null, after: null, private: true/);
    expect(filesWith(/\baudit\(ctx, `\$\{PREFIX\}/)).toEqual(['src/lib/knotwork/changelog.ts']);
    // An entry about a row that is about to be deleted is written first, while its privacy can still be read.
    for (const [f, del] of [['src/app/o/[org]/wedding/actions.ts', 'tx.task.delete('], ['src/lib/knotwork/vendors/attachments.ts', 'tx.vendorAttachment.delete('], ['src/lib/knotwork/funding/store.ts', 'tx.funderReceipt.delete(']] as const) {
      const text = strip(read(f));
      expect(text.indexOf(del), f).toBeGreaterThan(text.lastIndexOf('logChange(', text.indexOf(del)));
    }
  });
  it('what is stored and shared is written for nobody, and the export is built for nobody', () => {
    expect(strip(read('src/lib/knotwork/schedule/store.ts'))).toMatch(/nobodyLens\(tx, ctx\.orgId\)\)\?\.titles\(/);
    expect(strip(read('src/lib/knotwork/budget-store.ts'))).toMatch(/const L = await nobodyLens\(tx, ctx\.orgId\);/);
    expect(strip(read('src/lib/knotwork/vendors/store.ts'))).toMatch(/!L\?\.task\(t\)\.hidden/);
    const hooks = strip(read('src/app/export-hooks.ts'));
    for (const [table, fn] of [['Task', 'exportTasks'], ['Expense', 'exportExpenses'], ['BudgetCategory', 'exportCategories'], ['Vendor', 'exportVendors'], ['VendorPayment', 'exportVendorPayments'], ['VendorBrief', 'exportVendorBriefs'], ['VendorAttachment', 'exportVendorAttachments'], ['ScheduleBaseline', 'exportBaselines'], ['BudgetSnapshot', 'exportBudgetSnapshots']]) {
      expect(hooks, table).toContain(`whole('${table}', ${fn})`);
    }
  });
  it('privacy is two columns on four tables, an offset in days (no stored reveal date), and the database half is in the migration', () => {
    const schema = read('prisma/schema/knotwork.prisma');
    const withPrivacy = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].filter((m) => /privateToId/.test(m[2]!)).map((m) => m[1]);
    expect(withPrivacy).toEqual(['Task', 'BudgetCategory', 'Expense', 'Vendor']);
    for (const m of withPrivacy) expect(schema).toMatch(new RegExp(`model ${m} \\{[\\s\\S]*?revealDays\\s+Int\\?`));
    const sql = read('prisma/migrations/20261126000000_knotwork_secrecy_funders/migration.sql');
    for (const c of ['Vendor_designated_shared_check', 'Expense_designated_shared_check', 'Task_reveal_check', 'Vendor_reveal_check', 'Expense_reveal_check', 'BudgetCategory_reveal_check']) expect(sql).toContain(`"${c}"`);
    for (const t of ['Task_private_owner', 'BudgetCategory_private_owner', 'Expense_private_owner', 'Vendor_private_owner', 'FunderPledge_check', 'FunderReceipt_check', 'FunderAllocation_check']) expect(sql).toContain(`CREATE ${/_check$/.test(t) ? 'CONSTRAINT ' : ''}TRIGGER "${t}"`);
  });
  it('a designated proposal reveals what it names first; only the secrecy store writes privacy on an existing row', () => {
    const actions = strip(read('src/app/o/[org]/wedding/actions.ts'));
    for (const kind of ['book_vendor', 'sign_contract', 'spend']) {
      const at = actions.search(new RegExp(`await propose\\(tx, ctx, [^\\n]*?'${kind}'`));
      expect(at, kind).toBeGreaterThan(0);
      expect(actions.lastIndexOf('revealForProposal(', at), kind).toBeGreaterThan(actions.lastIndexOf('orgAction(', at));
    }
    expect(filesWith(/\bsetExpenseCompartment\(/)).toEqual(['src/lib/knotwork/budget-store.ts', 'src/lib/knotwork/secrecy/store.ts']);
    expect(filesWith(/\bsetPrivacy\(/)).toEqual(['src/app/o/[org]/wedding/privacy/actions.ts', 'src/lib/knotwork/secrecy/store.ts']);
    expect(filesWith(/\brevealForProposal\(/)).toEqual(['src/app/o/[org]/wedding/actions.ts', 'src/lib/knotwork/secrecy/store.ts']);
  });
});
