import { chromium } from 'playwright';
const SB = 'https://vpuvhkermemvkapbrngu.supabase.co';
const UID = '11111111-2222-4333-8444-555555555555';
export const db = { jumps: new Map(), profiles: new Map(), allowed: [{ email: 'aldogordoni@gmail.com', is_admin: true, note: 'Owner', added_at: new Date().toISOString() }], objects: new Map() };
export const log = []; const fnCalls = []; let passwordSet = null;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, email: 'aldogordoni@gmail.com', role: 'authenticated', aud: 'authenticated', exp, iat: exp - 3600, session_id: 's1' })}.sig`;
const user = { id: UID, email: 'aldogordoni@gmail.com', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() };
const session = { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r1', user };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
const parseEq = (v) => v?.replace(/^eq\./, '');

export async function handle(route) {
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



export { SB, UID, json, parseEq };
