// Sign in with username + password.
//
// The username → email lookup happens here, with the service role, so the app never
// learns (and can't leak) which email belongs to which username. Repeated wrong
// passwords for a username are throttled: 5 failures locks it for 15 minutes.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = ['https://aldogordoni.github.io', 'http://localhost:4200'];
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function reply(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'Method not allowed' });

  let username = '';
  let password = '';
  try {
    const body = await req.json();
    username = String(body.username ?? '').trim().toLowerCase();
    password = String(body.password ?? '');
  } catch {
    return reply(req, 400, { error: 'Bad request' });
  }
  if (!/^[a-z0-9_.]{3,24}$/.test(username) || !password) {
    return reply(req, 400, { error: 'WRONG_CREDENTIALS' });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await admin
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('username', username)
    .gte('at', since);
  if ((count ?? 0) >= MAX_FAILURES) return reply(req, 429, { error: 'TOO_MANY_ATTEMPTS' });

  const fail = async () => {
    await admin.from('login_attempts').insert({ username });
    return reply(req, 400, { error: 'WRONG_CREDENTIALS' });
  };

  const { data: profile } = await admin.from('profiles').select('user_id').eq('username', username).maybeSingle();
  if (!profile) return fail();
  const { data: found } = await admin.auth.admin.getUserById(profile.user_id);
  const email = found?.user?.email;
  if (!email) return fail();

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return fail();

  await admin.from('login_attempts').delete().eq('username', username);
  return reply(req, 200, {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
});
