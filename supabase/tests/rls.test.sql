-- Security rule tests. Run after supabase-stub.sql and all migrations:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql
-- Each check raises "FAIL: …" and stops the run if a rule is wrong.

\set ON_ERROR_STOP 1
set client_min_messages = notice;
\pset tuples_only on
\pset format unaligned

create function public.t_check(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAIL: %', msg; end if;
  raise notice 'ok: %', msg;
end $$;
grant execute on function public.t_check(boolean, text) to authenticated;

-- A user acting through the API.
create function public.t_as(uid uuid, email text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'email', email)::text, false);
  select set_config('role', 'authenticated', false);
$$;

-- Fixtures (as the database owner)
insert into public.allowed_emails (email) values
  ('coach@test.io'), ('ath@test.io'), ('ath2@test.io'), ('out@test.io');
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'coach@test.io'),
  ('22222222-2222-2222-2222-222222222222', 'ath@test.io'),
  ('44444444-4444-4444-4444-444444444444', 'ath2@test.io'),
  ('33333333-3333-3333-3333-333333333333', 'out@test.io');
insert into public.profiles (user_id, display_name, settings) values
  ('11111111-1111-1111-1111-111111111111', 'Coach Carla', '{"massKg": 70}'),
  ('22222222-2222-2222-2222-222222222222', 'Athlete Ada', '{"massKg": 61}');
insert into storage.buckets (id, name, public) values ('clips', 'clips', false) on conflict do nothing;
insert into storage.objects (bucket_id, name) values
  ('clips', '22222222-2222-2222-2222-222222222222/aaaaaaaa-0000-0000-0000-000000000001.mp4'),
  ('clips', '22222222-2222-2222-2222-222222222222/avatar.jpg'),
  ('clips', '11111111-1111-1111-1111-111111111111/avatar.jpg'),
  ('clips', '33333333-3333-3333-3333-333333333333/avatar.jpg'),
  ('clips', 'not-a-user/odd.mp4');

-- Athlete's own jumps
select public.t_as('22222222-2222-2222-2222-222222222222', 'ath@test.io');
insert into public.jumps (id, jumped_at, type, height_cm, flight_ms, capture_fps, frames, method)
values ('aaaaaaaa-0000-0000-0000-000000000001', now() - interval '1 day', 'CMJ', 41.2, 580, 240, 139, 'auto'),
       ('aaaaaaaa-0000-0000-0000-000000000002', now(), 'CMJ', 43.0, 592, 240, 142, 'auto');
reset role;

-- 1. Coach creates a squad and becomes its coach
select public.t_as('11111111-1111-1111-1111-111111111111', 'coach@test.io');
insert into public.squads (name) values ('Tuesday squad') returning id as squad, invite_code as code \gset
select public.t_check((select role from public.squad_members where squad_id = :'squad' and user_id = auth.uid()) = 'coach',
  'creator is the coach');
select public.t_check((select count(*) from public.jumps where user_id = '22222222-2222-2222-2222-222222222222') = 0,
  'coach sees no athlete jumps before anyone joins');
reset role;

-- 2. Joining
select public.t_as('33333333-3333-3333-3333-333333333333', 'out@test.io');
select public.t_check((select count(*) from public.squads) = 0, 'outsider cannot see the squad');
select public.t_check(public.join_squad('NOPE1234') is null, 'unknown invite code joins nothing');
select public.t_check((select count(*) from public.squad_roster(:'squad')) = 0, 'outsider gets no roster');
select public.t_check((select count(*) from public.squad_leaderboard(:'squad', 'CMJ', now() - interval '1 year')) = 0,
  'outsider gets no leaderboard');
reset role;

select public.t_as('22222222-2222-2222-2222-222222222222', 'ath@test.io');
select public.t_check(public.join_squad(lower(:'code')) = :'squad'::uuid, 'athlete joins with the code (any case)');
reset role;
select public.t_as('44444444-4444-4444-4444-444444444444', 'ath2@test.io');
select public.t_check(public.join_squad(:'code') = :'squad'::uuid, 'second athlete joins');
reset role;

-- 3. Consent: nothing is shared until the athlete says so
select public.t_as('11111111-1111-1111-1111-111111111111', 'coach@test.io');
select public.t_check((select count(*) from public.jumps where user_id = '22222222-2222-2222-2222-222222222222') = 0,
  'joining alone shares nothing');
do $$ begin
  update public.squad_members set share_jumps = true where user_id = '22222222-2222-2222-2222-222222222222';
  raise exception 'FAIL: coach switched on an athlete''s sharing';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: coach cannot change an athlete''s consent (%)', sqlerrm;
end $$;
select public.t_check((select count(*) from public.squad_roster(:'squad')) = 3, 'coach sees the roster');
select public.t_check(not exists (select 1 from public.squad_roster(:'squad') r where r.display_name is null and r.user_id = '22222222-2222-2222-2222-222222222222'),
  'roster shows names');
reset role;

select public.t_as('22222222-2222-2222-2222-222222222222', 'ath@test.io');
do $$ begin
  update public.squad_members set role = 'coach' where user_id = auth.uid();
  raise exception 'FAIL: athlete promoted themselves';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: athlete cannot make themselves a coach (%)', sqlerrm;
end $$;
update public.squad_members set share_jumps = true where user_id = auth.uid();
select public.t_check((select share_jumps from public.squad_members where user_id = auth.uid()), 'athlete turns sharing on');
-- Athlete can't read the coach's private profile settings through any route
select public.t_check((select count(*) from public.profiles where user_id = '11111111-1111-1111-1111-111111111111') = 0,
  'squad mates cannot read each other''s profile rows');
reset role;

-- 4. Coach access after consent
select public.t_as('11111111-1111-1111-1111-111111111111', 'coach@test.io');
select public.t_check((select count(*) from public.jumps where user_id = '22222222-2222-2222-2222-222222222222') = 2,
  'coach sees the sharing athlete''s jumps');
update public.jumps set height_cm = 99 where user_id = '22222222-2222-2222-2222-222222222222';
reset role;
select public.t_check((select max(height_cm) from public.jumps where user_id = '22222222-2222-2222-2222-222222222222') = 43,
  'coach cannot edit athlete jumps');
select public.t_as('11111111-1111-1111-1111-111111111111', 'coach@test.io');
do $$ begin
  insert into public.jumps (id, user_id, jumped_at, type, height_cm, flight_ms, capture_fps, frames, method)
  values (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', now(), 'CMJ', 80, 800, 240, 190, 'manual');
  raise exception 'FAIL: coach wrote a jump for the athlete';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: coach cannot add jumps for an athlete';
end $$;
select public.t_check((select count(*) from storage.objects where name like '22222222-2222-2222-2222-222222222222/%.mp4') = 1,
  'coach can open the sharing athlete''s clips');
select public.t_check((select count(*) from storage.objects where name like '33333333-%') = 0,
  'coach cannot see an outsider''s files');
-- Comments
insert into public.jump_comments (jump_id, body) values ('aaaaaaaa-0000-0000-0000-000000000002', 'Great dip depth, land softer.');
select public.t_check((select count(*) from public.jump_comments) = 1, 'coach comments on a shared jump');
reset role;

select public.t_as('44444444-4444-4444-4444-444444444444', 'ath2@test.io');
select public.t_check((select count(*) from public.jumps where user_id = '22222222-2222-2222-2222-222222222222') = 0,
  'a fellow athlete cannot see another athlete''s jumps');
select public.t_check((select count(*) from storage.objects where name like '22222222-2222-2222-2222-222222222222/%.mp4') = 0,
  'a fellow athlete cannot see clips');
select public.t_check((select count(*) from storage.objects where name = '22222222-2222-2222-2222-222222222222/avatar.jpg') = 1,
  'squad mates can see profile pictures');
select public.t_check((select count(*) from public.jump_comments) = 0, 'a fellow athlete cannot read the comments');
do $$ begin
  insert into public.jump_comments (jump_id, body) values ('aaaaaaaa-0000-0000-0000-000000000002', 'hi');
  raise exception 'FAIL: fellow athlete commented';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: a fellow athlete cannot comment';
end $$;
reset role;

select public.t_as('33333333-3333-3333-3333-333333333333', 'out@test.io');
select public.t_check((select count(*) from storage.objects where name like '22222222-%') = 0, 'outsider sees no athlete files');
select public.t_check((select count(*) from public.jumps where user_id <> auth.uid()) = 0, 'outsider sees no one else''s jumps');
reset role;

select public.t_as('22222222-2222-2222-2222-222222222222', 'ath@test.io');
select public.t_check((select count(*) from public.jump_comments) = 1, 'athlete reads the coach''s comment');
select public.t_check((select display_name from public.jump_comment_authors('aaaaaaaa-0000-0000-0000-000000000002') limit 1) = 'Coach Carla',
  'athlete sees who commented');
-- 5. Leaderboard is opt-in
select public.t_check((select count(*) from public.squad_leaderboard(:'squad', 'CMJ', now() - interval '1 year')) = 0,
  'nobody is on the leaderboard by default');
update public.squad_members set on_leaderboard = true where user_id = auth.uid();
select public.t_check((select best_height from public.squad_leaderboard(:'squad', 'CMJ', now() - interval '1 year')) = 43,
  'opted-in athlete appears with their best');
-- 6. Revoking consent cuts access at once
update public.squad_members set share_jumps = false where user_id = auth.uid();
reset role;
select public.t_as('11111111-1111-1111-1111-111111111111', 'coach@test.io');
select public.t_check((select count(*) from public.jumps where user_id = '22222222-2222-2222-2222-222222222222') = 0,
  'coach loses access when sharing is turned off');
select public.t_check((select count(*) from public.jump_comments) = 0, 'and loses the comment thread too');
-- Owner can't leave their own squad
delete from public.squad_members where user_id = auth.uid();
select public.t_check((select count(*) from public.squad_members where user_id = auth.uid()) = 1, 'owner cannot leave (delete the squad instead)');
reset role;

-- 7. Leaving, and an email that is no longer approved
select public.t_as('44444444-4444-4444-4444-444444444444', 'ath2@test.io');
delete from public.squad_members where user_id = auth.uid();
select public.t_check((select count(*) from public.squads) = 0, 'after leaving, the squad is gone from view');
reset role;
select public.t_as('22222222-2222-2222-2222-222222222222', 'not-approved@test.io');
select public.t_check((select count(*) from public.jumps) = 0, 'a token without an approved email sees nothing');
select public.t_check((select count(*) from public.squads) = 0, 'and no squads');
reset role;


-- ---------------------------------------------------------------------------
-- 0006: two-factor, error log, audit log, quota
-- ---------------------------------------------------------------------------
create function public.t_as_aal(uid uuid, email text, aal text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'email', email, 'aal', aal)::text, false);
  select set_config('role', 'authenticated', false);
$$;

-- Two-factor: once a factor is verified, an aal1 session sees nothing.
insert into auth.mfa_factors (user_id, status) values ('22222222-2222-2222-2222-222222222222', 'verified');
select public.t_as_aal('22222222-2222-2222-2222-222222222222', 'ath@test.io', 'aal1');
select public.t_check((select count(*) from public.jumps) = 0, 'with two-factor on, a password-only session sees nothing');
reset role;
select public.t_as_aal('22222222-2222-2222-2222-222222222222', 'ath@test.io', 'aal2');
select public.t_check((select count(*) from public.jumps) = 2, 'after the second step the athlete sees their jumps');
-- Error log
insert into public.client_errors (message, path) values ('TypeError: x is undefined', '/measure');
select public.t_check((select count(*) from public.client_errors) = 0, 'users cannot read the error log');
reset role;
select public.t_as('33333333-3333-3333-3333-333333333333', 'out@test.io');
do $$ begin
  insert into public.client_errors (user_id, message) values ('22222222-2222-2222-2222-222222222222', 'forged');
  raise exception 'FAIL: reported an error as someone else';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: cannot report errors as someone else';
end $$;
reset role;

-- Make the coach an admin, then check the audit log and admin views.
update public.allowed_emails set is_admin = true where email = 'coach@test.io';
select public.t_as('11111111-1111-1111-1111-111111111111', 'coach@test.io');
select public.t_check((select count(*) from public.client_errors) = 1, 'admins read the error log');
insert into public.allowed_emails (email, note) values ('new@test.io', 'friend');
update public.allowed_emails set note = 'teammate' where email = 'new@test.io';
select public.t_check(
  (select string_agg(action, ',' order by id) from public.allowlist_audit where email = 'new@test.io') = 'insert,update',
  'allowlist changes are audited');
select public.t_check(
  (select actor_email from public.allowlist_audit where email = 'new@test.io' order by id limit 1) = 'coach@test.io',
  'audit records who made the change');
reset role;
select public.t_as('33333333-3333-3333-3333-333333333333', 'out@test.io');
select public.t_check((select count(*) from public.allowlist_audit) = 0, 'non-admins cannot read the audit log');
do $$ begin
  insert into public.allowlist_audit (action, email) values ('insert', 'fake@test.io');
  raise exception 'FAIL: wrote to the audit log directly';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: nobody can write the audit log directly';
end $$;
reset role;

-- Quota: the 2001st file is refused.
insert into storage.objects (bucket_id, name)
select 'clips', '33333333-3333-3333-3333-333333333333/' || g || '.jpg' from generate_series(1, 1998) g;
select public.t_as('33333333-3333-3333-3333-333333333333', 'out@test.io');
insert into storage.objects (bucket_id, name) values ('clips', '33333333-3333-3333-3333-333333333333/ok.mp4');
select public.t_check(public.my_file_count() = 2000, 'uploads work under the quota');
do $$ begin
  insert into storage.objects (bucket_id, name) values ('clips', '33333333-3333-3333-3333-333333333333/over.mp4');
  raise exception 'FAIL: went over the quota';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'ok: uploads stop at the quota';
end $$;
reset role;

\echo 'All security rule checks passed.'
