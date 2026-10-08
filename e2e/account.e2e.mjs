import { BASE, fx, AXE } from './lib.mjs';
import { chromium } from 'playwright';
const SB = 'https://vpuvhkermemvkapbrngu.supabase.co';
const UID = '11111111-2222-4333-8444-555555555555';
const db = { jumps: new Map(), profiles: new Map(), allowed: [{ email: 'aldogordoni@gmail.com', is_admin: true, note: 'Owner', added_at: new Date().toISOString() }], objects: new Map() };
const log = []; const fnCalls = []; let passwordSet = null;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, email: 'aldogordoni@gmail.com', role: 'authenticated', aud: 'authenticated', exp, iat: exp - 3600, session_id: 's1' })}.sig`;
const user = { id: UID, email: 'aldogordoni@gmail.com', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() };
const session = { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r1', user };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
const parseEq = (v) => v?.replace(/^eq\./, '');

async function handle(route) {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname, method = req.method();
  if (method === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  log.push(`${method} ${path}${url.search}`);
  const body = req.postData();
  // Auth
  if (path === '/auth/v1/otp') return json(route, {});
  if (path === '/auth/v1/verify') return json(route, session);
  if (path === '/auth/v1/user' && method === 'PUT') { passwordSet = JSON.parse(body).password; return json(route, user); }
  if (path === '/auth/v1/user') return json(route, user);
  if (path === '/auth/v1/logout') return route.fulfill({ status: 204 });
  if (path === '/auth/v1/token') {
    const b = JSON.parse(body || '{}');
    if (url.searchParams.get('grant_type') === 'password') return b.password === 'correct-horse' ? json(route, session) : json(route, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' }, 400);
    return json(route, session);
  }
  if (path === '/functions/v1/username-login') {
    const b = JSON.parse(body); fnCalls.push(b);
    return b.username === 'aldo.jumps' && b.password === 'correct-horse' ? json(route, { access_token: jwt, refresh_token: 'r1' }) : json(route, { error: 'WRONG_CREDENTIALS' }, 400);
  }

  // RPC
  if (path === '/rest/v1/rpc/is_allowed') return json(route, true);
  if (path === '/rest/v1/rpc/is_admin') return json(route, true);
  if (path === '/rest/v1/rpc/delete_my_account') return json(route, { message: 'not installed' }, 404);
  // Tables
  if (path === '/rest/v1/jumps') {
    if (method === 'GET') return json(route, [...db.jumps.values()]);
    if (method === 'POST') { for (const r of [].concat(JSON.parse(body))) db.jumps.set(r.id, { has_clip: false, ...db.jumps.get(r.id), ...r }); return route.fulfill({ status: 201 }); }
    if (method === 'PATCH') { const id = parseEq(url.searchParams.get('id')); db.jumps.set(id, { ...db.jumps.get(id), ...JSON.parse(body) }); return route.fulfill({ status: 204 }); }
    if (method === 'DELETE') { const ids = url.searchParams.get('id')?.match(/in\.\((.*)\)/)?.[1].split(',').map((s) => s.replace(/"/g, '')) ?? [...db.jumps.keys()]; ids.forEach((i) => db.jumps.delete(i)); return route.fulfill({ status: 204 }); }
  }
  if (path === '/rest/v1/profiles') {
    if (method === 'GET') { const row = db.profiles.get(UID); const one = /vnd\.pgrst\.object/.test(req.headers()['accept'] ?? ''); return one ? (row ? json(route, row) : json(route, { code: 'PGRST116' }, 406)) : json(route, row ? [row] : []); }
    if (method === 'POST') { const r = JSON.parse(body); db.profiles.set(UID, { ...db.profiles.get(UID), ...r }); return route.fulfill({ status: 201 }); }
    if (method === 'DELETE') { db.profiles.delete(UID); return route.fulfill({ status: 204 }); }
  }
  if (path === '/rest/v1/allowed_emails') {
    if (method === 'GET') return json(route, db.allowed);
    if (method === 'POST') { const r = JSON.parse(body); if (db.allowed.some((a) => a.email === r.email)) return json(route, { message: 'duplicate key value' }, 409); db.allowed.push({ ...r, added_at: new Date().toISOString() }); return route.fulfill({ status: 201 }); }
    if (method === 'DELETE') { const e = parseEq(url.searchParams.get('email')); db.allowed = db.allowed.filter((a) => a.email !== e); return route.fulfill({ status: 204 }); }
    if (method === 'PATCH') { const e = parseEq(url.searchParams.get('email')); db.allowed = db.allowed.map((a) => a.email === e ? { ...a, ...JSON.parse(body) } : a); return route.fulfill({ status: 204 }); }
  }
  // Storage
  let m;
  if ((m = path.match(/^\/storage\/v1\/object\/sign\/clips$/))) { const { paths } = JSON.parse(body); return json(route, paths.map((p) => ({ path: p, signedURL: `/object/sign/clips/${p}?token=t`, error: db.objects.has(p) ? null : 'not found' }))); }
  if ((m = path.match(/^\/storage\/v1\/object\/sign\/clips\/(.+)$/))) { const o = db.objects.get(decodeURIComponent(m[1])); return o ? route.fulfill({ status: 200, contentType: o.type, body: o.buf }) : route.fulfill({ status: 404 }); }
  if ((m = path.match(/^\/storage\/v1\/object\/list\/clips$/))) { const { prefix } = JSON.parse(body); return json(route, [...db.objects.keys()].filter((k) => k.startsWith(prefix + '/')).map((k) => ({ name: k.split('/').pop() }))); }
  if (path === '/storage/v1/object/clips' && method === 'DELETE') { const { prefixes } = JSON.parse(body); prefixes.forEach((p) => db.objects.delete(p)); return json(route, []); }
  if ((m = path.match(/^\/storage\/v1\/object\/(?:authenticated\/)?clips\/(.+)$/))) {
    const key = decodeURIComponent(m[1]);
    if (method === 'POST' || method === 'PUT') {
      let buf = req.postDataBuffer(); let type = req.headers()['content-type'];
      const bm = type?.match(/boundary=(.+)$/);
      if (bm) { // multipart: pull out the file part
        const s = buf.toString('latin1'); const parts = s.split('--' + bm[1]);
        const file = parts.find((p) => /filename=/.test(p) || /Content-Type: (video|image)/.test(p));
        const hdrEnd = file.indexOf('\r\n\r\n'); type = file.match(/Content-Type: ([^\r\n]+)/)?.[1] ?? 'application/octet-stream';
        buf = Buffer.from(file.slice(hdrEnd + 4, file.length - 2), 'latin1');
      }
      db.objects.set(key, { buf, type }); return json(route, { Key: 'clips/' + key }); }
    if (method === 'GET') { const o = db.objects.get(key); return o ? route.fulfill({ status: 200, contentType: o.type, body: o.buf }) : json(route, { message: 'not found' }, 400); }
  }
  console.log('UNHANDLED', method, path, url.search);
  return json(route, { message: 'unhandled' }, 500);
}


const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const mk = async () => { const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', acceptDownloads: true }); await c.addInitScript(() => { const k = 'jump-meter.settings.v1'; if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ onboarded: true })); }); const p = await c.newPage(); p.on('pageerror', (e) => console.log('pageerror', e.message)); await p.route(SB + '/**', handle); return p; };
const base = BASE;
let page = await mk();
const go = async (n) => { await page.locator('input.scrub').fill(String(n)); await page.waitForFunction(() => !document.querySelector('.busy')); };
const set = async (t) => page.locator('.mark-card', { has: page.locator(`h3:text-is("${t}")`) }).getByRole('button', { name: /^Set to frame/ }).click();

// --- 1. Backup round trip (signed out)
await page.goto(base + '#/measure');
await page.setInputFiles('input[type=file]', fx('dated.mp4'));
await page.waitForSelector('canvas');
await go(97); await set('Take-off'); await go(228); await set('Landing');
await page.fill('#note', 'backup test');
await page.click('button:has-text("Save CMJ")');
await page.waitForSelector('text=See history', { timeout: 120000 });
await page.goto(base + '#/setup');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('button:has-text("Export backup")')]);
await dl.saveAs('backup-test.zip');
console.log('1. export:', (await page.textContent('.msg')).trim(), '| file:', dl.suggestedFilename());

page = await mk(); // fresh phone: empty storage
await page.goto(base + '#/setup');
await page.setInputFiles('input[type=file][accept*=zip]', 'backup-test.zip');
await page.waitForFunction(() => /Imported|Nothing new|Couldn't/.test(document.querySelector('.msg')?.textContent ?? ''), null, { timeout: 60000 });
console.log('   import on fresh phone:', (await page.textContent('.msg')).trim());
await page.goto(base + '#/history');
await page.waitForSelector('.thumb', { timeout: 10000 });
console.log('   history:', (await page.textContent('.list li')).replace(/\s+/g, ' ').slice(0, 110));
await page.click('.thumb'); await page.waitForSelector('.viewer video'); await page.waitForTimeout(1500);
console.log('   restored clip plays:', await page.evaluate(() => { const v = document.querySelector('.viewer video'); return { dur: Math.round(v.duration * 10) / 10, err: v.error?.code ?? null }; }));
await page.click('.viewer button:text-is("Close")');

// --- 2. Password sign-in
await page.goto(base + '#/account');
await page.fill('#ident', 'aldogordoni@gmail.com'); await page.fill('#pw', 'wrong');
await page.click('form button:text-is("Sign in")'); await page.waitForSelector('.error');
console.log('2. wrong email password:', (await page.textContent('.error')).trim());
await page.fill('#pw', 'correct-horse'); await page.click('form button:text-is("Sign in")');
await page.waitForSelector('.profile', { timeout: 15000 });
console.log('   email+password: signed in, setup prompt =', await page.locator('.notice').count() === 1);
// imported jump + clip uploaded to the cloud
await page.waitForTimeout(3000);
console.log('   cloud after sign-in: rows', db.jumps.size, 'notes', [...db.jumps.values()].map((r) => r.note), 'objects', [...db.objects.keys()].map((k) => k.split('/')[1]));

// --- 3. Profile, picture, password
await page.fill('#dname', 'Aldo'); await page.fill('#uname', 'Aldo.Jumps');
await page.click('button:has-text("Save profile")'); await page.waitForSelector('.ok');
console.log('3. profile saved:', JSON.stringify({ u: db.profiles.get(UID)?.username, d: db.profiles.get(UID)?.display_name }), '| header:', await page.getAttribute('header a.acct', 'aria-label'));
await page.setInputFiles('.pic input[type=file]', fx('avatar.png'));
await page.waitForFunction(() => /Picture updated/.test(document.querySelector('.ok')?.textContent ?? ''), null, { timeout: 15000 });
console.log('   avatar:', [...db.objects.keys()].filter((k) => k.endsWith('avatar.jpg')).length === 1, db.profiles.get(UID)?.avatar_path?.endsWith('avatar.jpg'), '| header img:', await page.locator('header app-avatar img').count());
await page.fill('#npw', 'correct-horse'); await page.fill('#npw2', 'correct-hors');
await page.click('button:has-text("Set password")'); await page.waitForSelector('.error');
console.log('   mismatch:', (await page.textContent('.error')).trim());
await page.fill('#npw2', 'correct-horse'); await page.click('button:has-text("Set password")'); await page.waitForFunction(() => /Password set/.test(document.querySelector('.ok')?.textContent ?? ''), null, { timeout: 15000 });
console.log('   password set:', passwordSet === 'correct-horse');
await page.screenshot({ path: 'account.png', fullPage: true });

// --- 4. Username sign-in on another phone
page = await mk();
await page.goto(base + '#/account');
await page.fill('#ident', '@Aldo.Jumps'); await page.fill('#pw', 'correct-horse');
await page.click('form button:text-is("Sign in")');
await page.waitForSelector('.profile', { timeout: 15000 });
await page.waitForTimeout(2500);
console.log('   function requests:', log.filter((l) => /functions/.test(l)));
console.log('4. username sign-in sent:', JSON.stringify(fnCalls.at(-1)), '| shows:', (await page.textContent('.who .name')).trim(), '| jumps pulled:', await page.evaluate(() => JSON.parse(localStorage.getItem('jump-meter.history.v1') || '[]').length));
await page.goto(base + '#/account');
await page.click('button:text-is("Sign out")'); await page.waitForSelector('#ident');
await page.fill('#ident', 'aldo.jumps'); await page.fill('#pw', 'nope'); await page.click('form button:text-is("Sign in")'); await page.waitForSelector('.error');
console.log('   wrong username password:', (await page.textContent('.error')).trim());
await page.screenshot({ path: 'signin.png', fullPage: true });
await browser.close();
