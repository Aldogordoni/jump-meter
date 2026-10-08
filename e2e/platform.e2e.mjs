import { BASE, fx, AXE } from './lib.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { handle, db, SB, UID, json } from './fake-sb.mjs';
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);

// Two-step sign-in: the account has a verified authenticator; the password session is aal1.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const mkJwt = (aal) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, email: 'aldogordoni@gmail.com', role: 'authenticated', aud: 'authenticated', exp, iat: exp - 3600, session_id: 's1', aal, amr: [{ method: aal === 'aal2' ? 'totp' : 'password', timestamp: exp - 3600 }] })}.sig`;
const factor = { id: 'f1111111-1111-4111-8111-111111111111', friendly_name: 'Jump Meter', factor_type: 'totp', status: 'verified', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' };
const user = { id: UID, email: 'aldogordoni@gmail.com', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-09-01T10:00:00Z', factors: [factor] };
const sess = (aal) => ({ access_token: mkJwt(aal), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r-' + aal, user });
let aal = 'aal1';
const rpcCalls = [];
const errorsSent = [];
const verifyCodes = [];

async function route(r) {
  const req = r.request();
  const url = new URL(req.url());
  const path = url.pathname, method = req.method();
  if (method === 'OPTIONS') return handle(r);
  if (path === '/auth/v1/token') {
    const b = JSON.parse(req.postData() || '{}');
    if (url.searchParams.get('grant_type') === 'password') return b.password === 'correct-horse' ? json(r, sess('aal1')) : json(r, { error: 'invalid_grant', msg: 'Invalid login credentials' }, 400);
    return json(r, sess(aal));
  }
  if (path === '/auth/v1/user') return json(r, user);
  if (path === `/auth/v1/factors/${factor.id}/challenge`) return json(r, { id: 'c1', type: 'totp', expires_at: exp });
  if (path === `/auth/v1/factors/${factor.id}/verify`) {
    const b = JSON.parse(req.postData());
    verifyCodes.push(b.code);
    if (b.code !== '123456') return json(r, { code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422);
    aal = 'aal2';
    return json(r, sess('aal2'));
  }
  if (path.startsWith('/rest/v1/rpc/')) {
    rpcCalls.push(path.split('/').pop() + ':' + aal);
    if (path.endsWith('my_storage_bytes')) return json(r, 5_400_000);
    // The server refuses data to an aal1 session once two-step is on.
    if (path.endsWith('is_allowed') || path.endsWith('is_admin')) return json(r, aal === 'aal2');
  }
  if (path === '/rest/v1/client_errors' && method === 'POST') { errorsSent.push(...JSON.parse(req.postData())); return r.fulfill({ status: 201 }); }
  if (path === '/rest/v1/client_errors' && method === 'GET') return json(r, errorsSent.map((e, i) => ({ id: i + 1, ...e })));
  if (path === '/rest/v1/allowlist_audit') return json(r, [{ id: 1, at: '2026-10-07T12:00:00Z', actor_email: 'aldogordoni@gmail.com', action: 'insert', email: 'friend@example.com', is_admin: false, note: 'teammate' }]);
  if (path.startsWith('/realtime/')) return r.abort();
  return handle(r);
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => { const k = 'jump-meter.settings.v1'; if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ onboarded: true })); });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('dialog', (d) => d.accept());
await ctx.route(SB + '/**', route);
await ctx.routeWebSocket(/supabase\.co\/realtime/, (ws) => ws.close());
const base = BASE;

// Seed one local, already-synced jump: an aal1 session must not wipe it.
await page.goto(base + '#/account');
await page.evaluate(() => localStorage.setItem('jump-meter.history.v1', JSON.stringify([{ id: '99999999-9999-4999-8999-999999999999', date: '2026-10-01T10:00:00Z', heightCm: 45, flightMs: 605, captureFps: 240, frames: 145, type: 'CMJ', method: 'auto', synced: true }])));
await page.reload();
await page.fill('#ident', 'aldogordoni@gmail.com');
await page.fill('#pw', 'correct-horse');
await page.click('form button:text-is("Sign in")');
await page.waitForSelector('#mfa', { timeout: 15000 });
ok(true, 'code is asked for after the password');
ok(!rpcCalls.some((c) => c.endsWith(':aal1') && c.startsWith('is_allowed')), 'no data calls before the second step');
ok((await page.evaluate(() => JSON.parse(localStorage.getItem('jump-meter.history.v1')).length)) === 1, 'local jumps untouched while waiting for the code');
await page.fill('#mfa', '000000');
await page.click('button:text-is("Verify")');
await page.waitForSelector('.error');
ok(/didn't work/.test(await page.textContent('.error')), 'wrong code explained');
await page.fill('#mfa', '123456');
await page.click('button:text-is("Verify")');
await page.waitForSelector('text=Two-step sign-in', { timeout: 10000 });
await page.waitForSelector('text=On. Signing in also asks', { timeout: 10000 });
ok(true, 'signed in after the code; two-step shown as on');
ok(verifyCodes.join(',') === '000000,123456', 'codes sent to the verify endpoint');

// Password meter
await page.fill('#npw', 'password1');
ok(/Too weak/.test(await page.textContent('.meter')), 'common password flagged');
ok(await page.locator('button:text-is("Set password")').isDisabled(), 'weak password cannot be saved');
await page.fill('#npw', 'orange-cliff-bicycle-river');
ok(/Strong|Very strong/.test(await page.textContent('.meter')), 'passphrase rated strong');
await page.screenshot({ path: 's5-account.png', fullPage: true });

// Error reporting: throw inside Angular, check it reaches the server scrubbed.
await page.evaluate(() => setTimeout(() => { throw new Error('Test failure for aldogordoni@gmail.com token=abc123'); }));
await page.waitForFunction(() => true);
for (let i = 0; i < 20 && !errorsSent.length; i++) await page.waitForTimeout(500);
ok(errorsSent.length === 1, 'error reported');
ok(errorsSent[0] && !/aldogordoni|abc123/.test(errorsSent[0].message), 'error scrubbed: ' + errorsSent[0]?.message);

// Admin: audit log and errors
await page.goto(base + '#/admin');
await page.waitForSelector('.log li');
const admin = (await page.textContent('main')).replace(/\s+/g, ' ');
ok(/Approved friend@example.com/.test(admin), 'change log shown');
ok(/Test failure for <email>/.test(admin), 'error shown to admin');

// Setup storage + privacy
await page.goto(base + '#/setup');
await page.waitForFunction(() => /In your account: 5.1 MB/.test(document.body.textContent));
ok(true, 'cloud storage shown');
await page.click('a:text-is("Privacy details")');
await page.waitForSelector('h1:text-is("Privacy")');
ok(/Ireland/.test(await page.textContent('main')), 'privacy page');
await browser.close();
