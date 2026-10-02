-- Jump Meter: cloud storage with an admin-managed email whitelist.
--
-- Run this once in Supabase → SQL Editor → New query → Run.
-- It is safe to re-run: everything is "create or replace" / "if not exists".
--
-- Security model
--   * Only emails in public.allowed_emails can create an account (trigger on auth.users).
--   * Every table and the clips bucket also check the whitelist on each request (RLS),
--     so removing an email cuts off access immediately, even for existing sessions.
--   * Each user can only ever see and change their own rows and files.
--   * Admins (is_admin = true in allowed_emails) manage the whitelist from the app.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Whitelist
-- ---------------------------------------------------------------------------

create table if not exists public.allowed_emails (
  email      text primary key check (email = lower(btrim(email)) and email like '%_@_%'),
  is_admin   boolean not null default false,
  note       text,
  added_at   timestamptz not null default now(),
  added_by   uuid references auth.users (id) on delete set null
);
alter table public.allowed_emails enable row level security;

-- The owner. Change this if you ever hand the admin role to someone else.
insert into public.allowed_emails (email, is_admin, note)
values ('aldogordoni@gmail.com', true, 'Owner')
on conflict (email) do update set is_admin = true;

create or replace function public.is_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.allowed_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.allowed_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', '')) and a.is_admin
  );
$$;

revoke execute on function public.is_allowed() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_allowed() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- Block sign-ups from emails that aren't on the list.
create or replace function private.enforce_allowlist()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null or not exists (
    select 1 from public.allowed_emails where email = lower(btrim(new.email))
  ) then
    raise exception 'EMAIL_NOT_APPROVED' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_allowlist on auth.users;
create trigger enforce_allowlist
  before insert on auth.users
  for each row execute function private.enforce_allowlist();

-- Normalise emails and stop the last admin being removed or demoted.
create or replace function private.guard_allowed_emails()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    new.email := lower(btrim(new.email));
    if tg_op = 'INSERT' then
      new.added_by := auth.uid();
      new.added_at := now();
    end if;
  end if;
  if (tg_op = 'DELETE' and old.is_admin) or (tg_op = 'UPDATE' and old.is_admin and not new.is_admin) then
    if (select count(*) from public.allowed_emails where is_admin) <= 1 then
      raise exception 'LAST_ADMIN' using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists guard_allowed_emails on public.allowed_emails;
create trigger guard_allowed_emails
  before insert or update or delete on public.allowed_emails
  for each row execute function private.guard_allowed_emails();

drop policy if exists "allowlist: admins read all, users read own" on public.allowed_emails;
create policy "allowlist: admins read all, users read own" on public.allowed_emails
  for select to authenticated
  using ((select public.is_admin()) or email = lower(coalesce((select auth.jwt()) ->> 'email', '')));

drop policy if exists "allowlist: admins insert" on public.allowed_emails;
create policy "allowlist: admins insert" on public.allowed_emails
  for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "allowlist: admins update" on public.allowed_emails;
create policy "allowlist: admins update" on public.allowed_emails
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "allowlist: admins delete" on public.allowed_emails;
create policy "allowlist: admins delete" on public.allowed_emails
  for delete to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Per-user data
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create table if not exists public.jumps (
  id                 uuid primary key,
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  jumped_at          timestamptz not null,
  type               text not null,
  height_cm          real not null check (height_cm >= 0 and height_cm < 300),
  flight_ms          real not null,
  capture_fps        real not null,
  frames             real not null,
  method             text not null,
  note               text check (char_length(note) <= 500),
  contact_ms         real,
  rsi                real,
  box_cm             real,
  time_to_takeoff_ms real,
  rsi_mod            real,
  has_clip           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists jumps_user_date on public.jumps (user_id, jumped_at desc);
alter table public.jumps enable row level security;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'jumps'] loop
    execute format('drop policy if exists "%1$s: own rows" on public.%1$I', t);
    execute format(
      'create policy "%1$s: own rows" on public.%1$I for all to authenticated
         using (user_id = (select auth.uid()) and (select public.is_allowed()))
         with check (user_id = (select auth.uid()) and (select public.is_allowed()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Video clips: private bucket, one folder per user  (clips/<user id>/<jump id>.mp4)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', false, 52428800, array['video/mp4', 'video/webm', 'image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "clips: own files read" on storage.objects;
create policy "clips: own files read" on storage.objects for select to authenticated
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.is_allowed()));

drop policy if exists "clips: own files insert" on storage.objects;
create policy "clips: own files insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.is_allowed()));

drop policy if exists "clips: own files update" on storage.objects;
create policy "clips: own files update" on storage.objects for update to authenticated
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.is_allowed()))
  with check (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.is_allowed()));

drop policy if exists "clips: own files delete" on storage.objects;
create policy "clips: own files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.is_allowed()));
