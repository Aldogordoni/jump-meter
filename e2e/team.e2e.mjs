import { BASE, fx, AXE } from './lib.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { handle, db, SB, UID, json, parseEq } from './fake-sb.mjs';
const axe = fs.readFileSync(AXE, 'utf8');
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);

// --- Fake squad backend (mirrors the database rules for this scenario) ---
const ADA = 'aaaaaaaa-1111-4111-8111-111111111111';
const BEN = 'bbbbbbbb-2222-4222-8222-222222222222';
const OWNER2 = 'cccccccc-3333-4333-8333-333333333333';
const squads = [
  { id: 's1', name: 'Club', owner_id: UID, invite_code: 'CLUB0001', created_at: '2026-09-01T10:00:00Z' },
  { id: 's2', name: 'Volley crew', owner_id: OWNER2, invite_code: 'ABCD1234', created_at: '2026-09-02T10:00:00Z' },
];
const members = [
  { squad_id: 's1', user_id: UID, role: 'coach', share_jumps: false, on_leaderboard: true, joined_at: '2026-09-01T10:00:00Z' },
  { squad_id: 's1', user_id: ADA, role: 'athlete', share_jumps: true, on_leaderboard: true, joined_at: '2026-09-03T10:00:00Z' },
  { squad_id: 's1', user_id: BEN, role: 'athlete', share_jumps: false, on_leaderboard: false, joined_at: '2026-09-04T10:00:00Z' },
  { squad_id: 's2', user_id: OWNER2, role: 'coach', share_jumps: false, on_leaderboard: false, joined_at: '2026-09-02T10:00:00Z' },
];
const names = { [UID]: ['Aldo', 'aldo.jumps'], [ADA]: ['Ada Lovejump', 'ada'], [BEN]: [null, 'ben'], [OWNER2]: ['Coach Vee', 'vee'] };
const adaJumps = [];
for (let i = 0; i < 8; i++) {
  const d = new Date(Date.now() - (8 - i) * 3 * 86400000).toISOString();
  adaJumps.push({ id: `0000000${i}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, user_id: ADA, jumped_at: d, type: 'CMJ', height_cm: i === 7 ? 36 : 42 + (i % 3), flight_ms: 590, capture_fps: 240, frames: 141, method: 'auto', note: i === 7 ? 'tired legs' : null, contact_ms: null, rsi: null, box_cm: null, time_to_takeoff_ms: null, rsi_mod: null, has_clip: i === 7, session_id: null, tags: [], extra: i === 7 ? { posture: { flagged: true, kneeTakeoff: 172, kneeLanding: 140, hipTakeoff: 170, hipLanding: 150, inflationCm: 2.1 } } : {} });
}
db.objects.set(`${ADA}/${adaJumps[7].id}.mp4`, { buf: fs.readFileSync(fx('jump240.mp4')), type: 'video/mp4' });
const comments = [];
const patches = [];
let nextSquad = 3;

async function team(route) {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname, method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const one = /vnd\.pgrst\.object/.test(req.headers()['accept'] ?? '');
  if (path === '/rest/v1/squad_members') {
    if (method === 'GET') {
      const uid = parseEq(url.searchParams.get('user_id'));
      return json(route, members.filter((m) => m.user_id === uid).map((m) => ({ ...m, squads: squads.find((s) => s.id === m.squad_id) })));
    }
    if (method === 'PATCH') {
      patches.push({ q: url.search, body });
      const sq = parseEq(url.searchParams.get('squad_id')), uid = parseEq(url.searchParams.get('user_id'));
      const m = members.find((x) => x.squad_id === sq && x.user_id === uid);
      if (m && (body.share_jumps !== undefined || body.on_leaderboard !== undefined) && uid !== UID) return json(route, { message: 'only the member can change their sharing' }, 400);
      Object.assign(m, body);
      return route.fulfill({ status: 204 });
    }
    if (method === 'DELETE') {
      const sq = parseEq(url.searchParams.get('squad_id')), uid = parseEq(url.searchParams.get('user_id'));
      const i = members.findIndex((x) => x.squad_id === sq && x.user_id === uid);
      if (i >= 0) members.splice(i, 1);
      return route.fulfill({ status: 204 });
    }
  }
  if (path === '/rest/v1/squads' && method === 'POST') {
    const s = { id: `s${nextSquad++}`, name: body.name, owner_id: UID, invite_code: 'NEW00001', created_at: new Date().toISOString() };
    squads.push(s);
    members.push({ squad_id: s.id, user_id: UID, role: 'coach', share_jumps: false, on_leaderboard: false, joined_at: s.created_at });
    return json(route, one ? { id: s.id } : [{ id: s.id }], 201);
  }
  if (path === '/rest/v1/rpc/join_squad') {
    const s = squads.find((x) => x.invite_code === body.code.toUpperCase());
    if (s && !members.some((m) => m.squad_id === s.id && m.user_id === UID)) members.push({ squad_id: s.id, user_id: UID, role: 'athlete', share_jumps: false, on_leaderboard: false, joined_at: new Date().toISOString() });
    return json(route, s?.id ?? null);
  }
  if (path === '/rest/v1/rpc/squad_roster') {
    return json(route, members.filter((m) => m.squad_id === body.sq).map((m) => ({ ...m, display_name: names[m.user_id][0], username: names[m.user_id][1], avatar_path: null })));
  }
  if (path === '/rest/v1/rpc/squad_leaderboard') {
    const rows = members.filter((m) => m.squad_id === body.sq && m.on_leaderboard).map((m) => {
      const js = m.user_id === ADA ? adaJumps : [...db.jumps.values()].map((j) => ({ ...j, user_id: UID }));
      const mine = js.filter((j) => j.type === body.jump_type && j.jumped_at >= body.since);
      if (!mine.length) return null;
      return { user_id: m.user_id, display_name: names[m.user_id][0], username: names[m.user_id][1], avatar_path: null, best_height: Math.max(...mine.map((j) => j.height_cm)), best_rsi: null, best_distance: null, jumps: mine.length, last_jump: mine.at(-1).jumped_at };
    }).filter(Boolean);
    return json(route, rows);
  }
  if (path === '/rest/v1/jumps' && method === 'GET' && parseEq(url.searchParams.get('user_id')) === ADA) {
    return json(route, [...adaJumps].reverse());
  }
  if (path === '/rest/v1/jump_comments') {
    if (method === 'GET') {
      const jid = parseEq(url.searchParams.get('jump_id'));
      const ins = url.searchParams.get('jump_id')?.match(/^in\.\((.*)\)$/)?.[1].split(',').map((x) => x.replace(/"/g, ''));
      return json(route, comments.filter((c) => (ins ? ins.includes(c.jump_id) : c.jump_id === jid)));
    }
    if (method === 'POST') { comments.push({ id: `c${comments.length + 1}`, author_id: UID, created_at: new Date().toISOString(), ...body }); return route.fulfill({ status: 201 }); }
    if (method === 'DELETE') { const id = parseEq(url.searchParams.get('id')); const i = comments.findIndex((c) => c.id === id); if (i >= 0) comments.splice(i, 1); return route.fulfill({ status: 204 }); }
  }
  if (path === '/rest/v1/rpc/jump_comment_authors') {
    return json(route, [...new Set(comments.filter((c) => c.jump_id === body.jid).map((c) => c.author_id))].map((u) => ({ user_id: u, display_name: names[u]?.[0] ?? null, username: names[u]?.[1] ?? null })));
  }
  return handle(route);
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', bypassCSP: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('dialog', (d) => d.accept());
await page.route(SB + '/**', team);
const base = BASE;

// Sign in with a password; own data includes one synced jump.
await page.goto(base + '#/measure');
await page.evaluate(() => localStorage.setItem('jump-meter.settings.v1', JSON.stringify({ onboarded: true })));
await page.reload();
db.jumps.set('99999999-9999-4999-8999-999999999999', { id: '99999999-9999-4999-8999-999999999999', jumped_at: new Date(Date.now() - 86400000).toISOString(), type: 'CMJ', height_cm: 47.5, flight_ms: 622, capture_fps: 240, frames: 149, method: 'auto', note: null, contact_ms: null, rsi: null, box_cm: null, time_to_takeoff_ms: null, rsi_mod: null, has_clip: false, session_id: null, tags: [], extra: {} });
await page.goto(base + '#/account');
await page.fill('#ident', 'aldogordoni@gmail.com');
await page.fill('#pw', 'correct-horse');
await page.click('form button:text-is("Sign in")');
await page.waitForSelector('nav.tabs a:text-is("Team")', { timeout: 15000 });
ok(true, 'Team tab appears after signing in');

// Team page
await page.click('nav.tabs a:text-is("Team")');
await page.waitForSelector('.chips button');
ok((await page.locator('.chips button').count()) === 1, 'shows my squad');
await page.waitForSelector('.athletes li');
const ath = (await page.textContent('.athletes')).replace(/\s+/g, ' ');
console.log('ATHLETES', ath);
ok(/Ada Lovejump/.test(ath) && !/ben/.test(ath), 'only sharing athletes are listed');
ok(/Fatigued|Slightly down/.test(ath), 'athlete readiness shown');
await page.waitForSelector('.board li');
const board = (await page.textContent('.board')).replace(/\s+/g, ' ');
console.log('BOARD', board);
ok(/^1.*Aldo.*2.*Ada/.test(board), 'leaderboard ranked by best');
ok(/CLUB0001/.test(await page.textContent('.invite')), 'invite code shown to coach');
const mem = (await page.textContent('.members')).replace(/\s+/g, ' ');
ok(/@ben/.test(mem) && /not sharing/.test(mem), 'roster shows who shares');

// Athlete detail, clip, comment
await page.click('.ath');
await page.waitForSelector('.ath-detail .jrow');
ok(/bent landing/.test(await page.textContent('.ath-detail')), 'coach sees technique flags');
await page.click('.ath-detail button:has-text("Watch clip")');
await page.waitForSelector('app-clip-viewer video');
ok((await page.locator('app-clip-viewer button:has-text("Trim")').count()) === 0, "coach can't trim an athlete's clip");
await page.keyboard.press('Escape');
await page.locator('.ath-detail button:has-text("Comment")').first().click();
await page.fill('app-comments textarea', 'Land on straight legs, then bend. Nice depth.');
await page.click('app-comments button:has-text("Post")');
await page.waitForSelector('app-comments li');
ok(/You/.test(await page.textContent('app-comments li')), 'comment posted');
ok(comments.length === 1 && comments[0].jump_id === adaJumps[7].id, 'comment stored on the athlete jump');

// My consent toggles
await page.locator('.toggle input').first().check();
await page.waitForTimeout(400);
ok(patches.some((p) => p.body.share_jumps === true && /user_id=eq\.11111111/.test(p.q)), 'sharing consent saved for me only');

// Join a squad
await page.fill('#code', 'zzzz9999');
await page.click('button:text-is("Join")');
await page.waitForSelector('.error');
ok(/didn't match/.test(await page.textContent('.error')), 'unknown code is reported');
await page.fill('#code', 'abcd1234');
await page.click('button:text-is("Join")');
await page.waitForFunction(() => document.querySelectorAll('.chips button').length === 2);
ok(/Volley crew/.test(await page.textContent('.chips button.on')), 'joined squad is selected');
ok((await page.locator('#ath-h').count()) === 0, 'athletes panel hidden for non-coaches');
ok((await page.locator('.invite').count()) === 0, 'invite code hidden from athletes');
await page.screenshot({ path: 'team.png', fullPage: true });

// Create a squad
await page.fill('#sname', 'Morning group');
await page.click('button:text-is("Create")');
await page.waitForFunction(() => /Morning group/.test(document.querySelector('.chips button.on')?.textContent ?? ''));
ok(true, 'created squad is selected');

await page.addScriptTag({ content: axe });
const v = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((x) => x.id + ': ' + x.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')));
ok(v.length === 0, 'a11y team ' + v.join('; '));

// History: comments on my own jump
await page.goto(base + '#/history');
await page.waitForSelector('.row-actions button:has-text("Comments")', { timeout: 15000 });
await page.click('.row-actions button:has-text("Comments")');
await page.fill('app-comments textarea', 'Felt great today');
await page.click('app-comments button:has-text("Post")');
await page.waitForSelector('app-comments li');
ok(comments.some((c) => c.jump_id === '99999999-9999-4999-8999-999999999999'), 'comment on own jump');
await browser.close();
