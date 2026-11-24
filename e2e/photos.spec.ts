import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { inspect } from '../src/lib/knotwork/uploads/inspect';

// The photo wall on the served pages (PRD P0-6; docs/knotwork/PHASE-3-PLAN.md section 3), and the capstone's third
// demo story: a guest opens the upload link (the QR code's address), uploads a photo with no account, and it appears
// on the moderated wall after approval. The photo is a fixture that carries EXIF with a GPS position, XMP, an ICC
// profile and a comment; what the wall serves carries none of it. Then contract attachments, through the same pipeline.
const ORG = '/o/juniper-rowan';
const PHONE = 'fixtures/photos/strip/phone-gps.jpg';
let juniper: Page;
let eventPath: string;
let link: string;

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  return page;
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  execSync('npm run seed:couple:test');
  juniper = await signIn(browser, 'juniper@knotwork.demo.test');
});

test('the couple sees the event, its QR code and its link; both of its days come from the wedding date', async () => {
  await juniper.goto(`${ORG}/wedding/schedule`);
  await juniper.getByRole('navigation', { name: 'Wedding' }).getByRole('link', { name: 'Photos', exact: true }).click();
  const row = juniper.getByRole('row', { name: 'Photo event Reception' });
  await expect(row).toContainText('approve first');
  await expect(row).toContainText('3 live, 1 waiting, 0 removed');
  await expect(row).toContainText('open until');
  await row.getByRole('link', { name: 'Reception' }).click();
  await expect(juniper.getByRole('heading', { name: 'Reception', level: 1 })).toBeVisible();
  eventPath = new URL(juniper.url()).pathname;
  await expect(juniper.getByLabel('Event status')).toContainText('7 days after the wedding');
  await expect(juniper.getByLabel('Event status')).toContainText('365 days after the wedding');
  const qr = juniper.getByRole('img', { name: 'QR code for the upload link of Reception' });
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  link = (await juniper.getByRole('region', { name: 'Upload link' }).locator('code').textContent())!.trim();
  expect(new URL(link).pathname).toMatch(/^\/p\/[\w-]{43}$/);
});

test('DEMO STORY: a guest opens the upload link, uploads a photo, and it appears on the moderated wall after approval', async ({ browser }) => {
  test.setTimeout(120_000);
  // The wall, on its own screen, signed in as Juniper: dark, full screen, the QR code in the corner.
  const wall = await juniper.context().newPage();
  await wall.goto(`${eventPath}/wall`);
  const screen = wall.getByRole('main', { name: 'Photo wall' });
  await expect(screen).toBeVisible();
  expect(await screen.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).position, el.getBoundingClientRect().width === window.innerWidth, el.getBoundingClientRect().height === window.innerHeight])).toEqual(['rgb(0, 0, 0)', 'fixed', true, true]);
  await expect(wall.getByRole('img', { name: 'QR code: scan to add your photo' })).toBeVisible();
  const corner = await wall.getByRole('complementary', { name: 'Add your photo' }).boundingBox();
  expect(corner!.x + corner!.width).toBeGreaterThan(wall.viewportSize()!.width * 0.8); // bottom right
  expect(corner!.y + corner!.height).toBeGreaterThan(wall.viewportSize()!.height * 0.8);
  await expect(wall.getByLabel('Photos on the wall')).toHaveText('3');
  // Newest first, then rotation: the first slide is the newest approved photo, and the wall moves on by itself.
  const shownFirst = await screen.locator('img[data-photo]').getAttribute('data-photo');
  const feed = (await (await juniper.request.get(`${eventPath}/wall/feed`)).json()) as { photos: { id: string }[] };
  expect(feed.photos).toHaveLength(3);
  expect(shownFirst).toBe(feed.photos[0]!.id);
  await expect(screen.locator('img[data-photo]')).toHaveAttribute('data-photo', feed.photos[1]!.id, { timeout: 15_000 });

  // The guest: a browser with no account and no cookies, at the address the QR code holds.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const res = await guest.goto(new URL(link).pathname);
  expect(res!.status()).toBe(200);
  expect([res!.headers()['referrer-policy'], res!.headers()['x-robots-tag']]).toEqual(['no-referrer', 'noindex, nofollow']);
  expect(res!.headers()['cache-control']).toContain('no-store');
  await expect(guest.getByRole('heading', { name: 'Juniper & Rowan' })).toBeVisible();
  await expect(guest.locator('main')).toContainText('Add a photo to Reception.');
  // Rule 3: the wedding's title and the event's name, and nothing else about the wedding or anyone in it.
  const body = await guest.locator('main').innerText();
  for (const leak of ['Lindqvist', 'Ashby', 'Vale', 'Linda', 'First dance', 'wave', 'B list', 'waiting', '2027', 'Tulsa', 'photos']) expect(body, leak).not.toContain(leak);
  expect(await guest.locator('main img').count()).toBe(0); // no other guest's photo is shown here

  // A file that only says it is a JPEG is refused, in a sentence, and nothing is added.
  await guest.getByLabel('Photo (take one, or choose one from your gallery)').setInputFiles({ name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
  await guest.getByRole('button', { name: 'Add photo' }).click();
  await expect(guest.locator('main').getByRole('alert')).toContainText('That file is not a JPEG, PNG or WebP image.');
  expect(new URL(guest.url()).search).toBe('?e=type');

  // The real upload: a phone photo, with a name and a caption.
  expect(inspect(readFileSync(PHONE)).map((f) => f.kind).sort()).toEqual(['comment', 'exif', 'gps', 'icc', 'xmp']);
  await guest.getByLabel('Photo (take one, or choose one from your gallery)').setInputFiles(PHONE);
  await guest.getByLabel('Your name (optional)').fill('Dana');
  await guest.getByLabel('Caption (optional)').fill('Sparklers at the send-off');
  await guest.getByRole('button', { name: 'Add photo' }).click();
  await expect(guest.locator('main').getByRole('status')).toContainText('Your photo will appear on the wall once it has been approved.');
  expect(new URL(guest.url()).search).toBe('?done=pending');
  // The device is a cookie only this browser holds: httpOnly, SameSite=Lax, sent only to the upload pages.
  const cookie = (await guestContext.cookies()).find((x) => x.name === 'kw_photo_device')!;
  expect([cookie.httpOnly, cookie.sameSite, cookie.path]).toEqual([true, 'Lax', '/p']);
  expect(cookie.value).toMatch(/^[\w-]{43}$/);

  // Moderated: it is NOT on the wall yet. The wall has polled at least once since the upload and still shows three.
  await wall.waitForResponse((r) => r.url().endsWith('/wall/feed') && r.ok());
  await wall.waitForResponse((r) => r.url().endsWith('/wall/feed') && r.ok());
  await expect(wall.getByLabel('Photos on the wall')).toHaveText('3');
  await expect(screen).not.toContainText('Sparklers');

  // Juniper approves it in the moderation console.
  await juniper.goto(`${eventPath}/moderate`);
  const waiting = juniper.getByRole('region', { name: 'Waiting' });
  await expect(waiting.getByRole('heading')).toHaveText('Waiting (2)');
  await expect(waiting).toContainText('Dana: Sparklers at the send-off');
  await waiting.getByRole('button', { name: /^Approve: photo \w+ from Dana$/ }).click();
  await expect(juniper.getByRole('region', { name: 'Waiting' }).getByRole('heading')).toHaveText('Waiting (1)');
  await expect(juniper.getByRole('region', { name: 'Live' })).toContainText('Dana: Sparklers at the send-off');

  // And it appears on the wall, on the screen that has been open all along: no reload.
  await expect(screen.locator('figcaption')).toHaveText('Sparklers at the send-off — Dana', { timeout: 20_000 });
  await expect(wall.getByLabel('Photos on the wall')).toHaveText('4');
  const shown = screen.locator('img[data-photo]');
  await expect(shown).toHaveAttribute('alt', 'Sparklers at the send-off');
  expect(await shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(640);

  // What the wall serves is a re-encoded JPEG with none of the file's metadata, sent as what it is, to signed-in people only.
  const src = (await shown.getAttribute('src'))!;
  const served = await juniper.request.get(src);
  expect([served.status(), served.headers()['content-type'], served.headers()['x-content-type-options']]).toEqual([200, 'image/jpeg', 'nosniff']);
  expect(served.headers()['cache-control']).toContain('private');
  const bytes = await served.body();
  expect(inspect(bytes)).toEqual([]);
  for (const leak of ['Example Lane', 'Synthetic Guest', 'Knotwork Fixture Cam', 'Exif', 'xpacket']) expect(bytes.includes(leak), leak).toBe(false);
  expect(bytes.equals(readFileSync(PHONE))).toBe(false);
  const anonymous = await guest.request.get(src, { maxRedirects: 0 });
  expect(anonymous.status()).not.toBe(200); // the guest's browser has no session: it is sent to sign in, not the image
  expect(anonymous.headers()['content-type'] ?? '').not.toContain('image/');

  // A takedown takes it off the wall at once (the next poll), and can be undone.
  await juniper.getByRole('button', { name: /^Take down: photo \w+ from Dana$/ }).click();
  await expect(juniper.getByRole('region', { name: 'Removed' })).toContainText('Dana: Sparklers at the send-off');
  await expect(wall.getByLabel('Photos on the wall')).toHaveText('3', { timeout: 15_000 });
  await expect(screen).not.toContainText('Sparklers');
  await juniper.getByRole('button', { name: /^Undo: put it back: photo \w+ from Dana$/ }).click();
  await expect(wall.getByLabel('Photos on the wall')).toHaveText('4', { timeout: 15_000 });

  // The activity feed has the upload (by nobody signed in) and the approval (by Juniper).
  await juniper.goto(`${ORG}/wedding/activity`);
  const activity = await juniper.getByRole('list', { name: 'Activity' }).innerText();
  expect(activity).toContain('Photo from Dana at Reception');
  expect(activity).toMatch(/Juniper Vale approved a photo: Photo from Dana at Reception/);
  await guestContext.close();
  await wall.close();
});

test('the album and the gallery download hold the approved photos; hiding from the wall leaves the album alone', async () => {
  await juniper.goto(`${eventPath}/album`);
  await expect(juniper.getByRole('list', { name: 'Album' }).getByRole('listitem')).toHaveCount(4);
  await juniper.goto(`${eventPath}/moderate`);
  await juniper.getByRole('button', { name: /^Hide from the wall: photo \w+ from Dana$/ }).click();
  await expect(juniper.getByRole('region', { name: 'Live' })).toContainText('Hidden from the wall.');
  const feed = (await (await juniper.request.get(`${eventPath}/wall/feed`)).json()) as { photos: { caption: string }[] };
  expect(feed.photos.map((p) => p.caption)).not.toContain('Sparklers at the send-off');
  await juniper.goto(`${eventPath}/album`);
  await expect(juniper.getByRole('list', { name: 'Album' })).toContainText('Dana: Sparklers at the send-off');
  const zip = await juniper.request.get(`${eventPath}/zip`);
  expect([zip.status(), zip.headers()['content-type'], zip.headers()['content-disposition']]).toEqual([200, 'application/zip', 'attachment; filename="juniper-rowan-reception.zip"']);
  const archive = await zip.body();
  expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304');
  for (const name of ['photo-0001.jpg', 'photo-0004.jpg', 'captions.txt', 'Sparklers at the send-off']) expect(archive.includes(name), name).toBe(true);
  expect(archive.includes('photo-0005.jpg')).toBe(false); // the photo still waiting is not in it
});

test('a link that is unknown, or closed by the couple, is a plain 404; a helper without the permission has no photo pages', async ({ browser }) => {
  const guest = await (await browser.newContext()).newPage();
  expect((await guest.goto(`/p/${'x'.repeat(43)}`))!.status()).toBe(404);
  await juniper.goto(eventPath);
  await juniper.getByRole('button', { name: 'Close uploads now' }).click();
  await expect(juniper.getByLabel('Event status')).toContainText('Uploads are closed.');
  expect((await guest.goto(new URL(link).pathname))!.status()).toBe(404);
  await juniper.getByRole('button', { name: 'Open uploads again' }).click();
  await expect(juniper.getByLabel('Event status')).toContainText('Uploads are open until');
  expect((await guest.goto(new URL(link).pathname))!.status()).toBe(200);

  const maple = await signIn(browser, 'maple@knotwork.demo.test');
  expect((await maple.goto(`${ORG}/wedding/photos`))!.status()).toBe(404);
  expect((await maple.goto(`${eventPath}/wall`))!.status()).toBe(404);
  expect((await maple.request.get(`${eventPath}/wall/feed`)).status()).toBe(404);
  // With the permission, Maple can moderate, and still cannot change the event.
  await juniper.goto(`${ORG}/wedding/helpers`);
  const section = juniper.getByRole('region', { name: 'Helper maple@knotwork.demo.test' });
  await section.getByLabel('Permission for maple@knotwork.demo.test').selectOption('photos_moderate');
  await section.getByRole('button', { name: 'Give permission' }).click();
  await expect(section.getByRole('listitem').filter({ hasText: 'See and moderate the photo wall' })).toBeVisible(); // in the list of what Maple has, not just on offer
  expect((await maple.goto(`${eventPath}/moderate`))!.status()).toBe(200);
  await expect(maple.getByRole('region', { name: 'Waiting' }).getByRole('button', { name: /^Approve/ })).toHaveCount(1);
  await maple.goto(eventPath);
  await expect(maple.getByRole('button', { name: 'Replace the upload link' })).toHaveCount(0);
  await expect(maple.getByRole('button', { name: 'Close uploads now' })).toHaveCount(0);
});

test('contract attachments go through the same pipeline: an image is kept clean, a PDF is refused in a sentence', async () => {
  await juniper.goto(`${ORG}/wedding/vendors`);
  await juniper.getByRole('link', { name: 'Fennel & Fig Catering' }).click();
  const section = juniper.getByRole('region', { name: 'Contract attachments' });
  await expect(section).toContainText('Nothing attached yet.');
  await section.getByLabel('A photo or scan of a contract page').setInputFiles({ name: 'contract.pdf', mimeType: 'application/pdf', buffer: readFileSync('fixtures/photos/strip/contract.pdf') });
  await section.getByRole('button', { name: 'Attach' }).click();
  await expect(juniper.getByRole('region', { name: 'Contract attachments' }).getByRole('alert')).toContainText('That file is a PDF. PDFs are not accepted yet');
  await expect(juniper.getByRole('region', { name: 'Contract attachments' })).toContainText('Nothing attached yet.');

  const after = juniper.getByRole('region', { name: 'Contract attachments' });
  await after.getByLabel('A photo or scan of a contract page').setInputFiles(PHONE);
  await after.getByLabel('Label', { exact: true }).fill('Catering contract, page 1');
  await after.getByRole('button', { name: 'Attach' }).click();
  await expect(after.getByRole('status')).toHaveText('Attached.');
  const item = after.getByRole('listitem', { name: 'Attachment Catering contract, page 1' });
  await expect(item).toContainText('640×480');
  await expect(item).toContainText('added by Juniper Vale');
  const served = await juniper.request.get((await item.getByRole('link', { name: 'Catering contract, page 1' }).getAttribute('href'))!);
  expect([served.status(), served.headers()['content-type'], served.headers()['x-content-type-options']]).toEqual([200, 'image/jpeg', 'nosniff']);
  expect(inspect(await served.body())).toEqual([]);
  expect((await served.body()).includes('Example Lane')).toBe(false);

  await item.getByRole('button', { name: 'Remove Catering contract, page 1' }).click();
  await expect(juniper.getByRole('region', { name: 'Contract attachments' })).toContainText('Nothing attached yet.');
  await juniper.goto(`${ORG}/wedding/activity`);
  const activity = await juniper.getByRole('list', { name: 'Activity' }).innerText();
  expect(activity).toContain('Catering contract, page 1 (Fennel & Fig Catering)');
});
