-- Platform and security: error log, allowlist audit log, clip quota, two-factor
-- enforcement and realtime sync.

-- ---------------------------------------------------------------------------
-- Two-factor sign-in: once someone turns on an authenticator app, their data is only
-- reachable from a session that passed the second step (aal2).
-- ---------------------------------------------------------------------------

create or replace function public.mfa_ok()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      )
$$;
revoke execute on function public.mfa_ok() from public, anon;
grant execute on function public.mfa_ok() to authenticated;

create or replace function public.is_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.allowed_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) and public.mfa_ok();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.allowed_emails a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', '')) and a.is_admin
  ) and public.mfa_ok();
$$;

-- ---------------------------------------------------------------------------
-- Error log (instead of a third-party service): no personal data beyond the user id.
-- ---------------------------------------------------------------------------

create table if not exists public.client_errors (
  id          bigint generated always as identity primary key,
  user_id     uuid default auth.uid() references auth.users (id) on delete set null,
  at          timestamptz not null default now(),
  message     text not null check (char_length(message) <= 500),
  stack       text check (char_length(stack) <= 4000),
  path        text check (char_length(path) <= 200),
  app_version text check (char_length(app_version) <= 40),
  user_agent  text check (char_length(user_agent) <= 300)
);
create index if not exists client_errors_at on public.client_errors (at desc);
alter table public.client_errors enable row level security;

create or replace function public.errors_today()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.client_errors
  where user_id = (select auth.uid()) and at > now() - interval '1 day'
$$;
revoke execute on function public.errors_today() from public, anon;
grant execute on function public.errors_today() to authenticated;

create policy "errors: report (50 a day)" on public.client_errors for insert to authenticated
  with check ((select public.is_allowed()) and user_id = (select auth.uid()) and public.errors_today() < 50);
create policy "errors: admins read" on public.client_errors for select to authenticated
  using ((select public.is_admin()));
create policy "errors: admins clear" on public.client_errors for delete to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Audit log of approved-email changes
-- ---------------------------------------------------------------------------

create table if not exists public.allowlist_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  action      text not null,
  email       text not null,
  is_admin    boolean,
  note        text
);
create index if not exists allowlist_audit_at on public.allowlist_audit (at desc);
alter table public.allowlist_audit enable row level security;

create policy "audit: admins read" on public.allowlist_audit for select to authenticated
  using ((select public.is_admin()));

create or replace function private.audit_allowlist()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if tg_op = 'INSERT' or tg_op = 'UPDATE' then r := new; else r := old; end if;
  insert into public.allowlist_audit (actor_id, actor_email, action, email, is_admin, note)
  values ((select auth.uid()), (select auth.jwt()) ->> 'email', lower(tg_op), r.email, r.is_admin, r.note);
  return null;
end $$;
revoke execute on function private.audit_allowlist() from public, anon, authenticated;

create trigger audit_allowlist after insert or update or delete on public.allowed_emails
  for each row execute function private.audit_allowlist();

-- ---------------------------------------------------------------------------
-- Clip quota: at most 2000 files (about 1000 clips) per person.
-- ---------------------------------------------------------------------------

create or replace function public.my_file_count()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from storage.objects
  where bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.uid())::text
$$;
revoke execute on function public.my_file_count() from public, anon;
grant execute on function public.my_file_count() to authenticated;

create policy "clips: per-user quota" on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'clips' or public.my_file_count() < 2000);

-- Cloud storage used, for the Setup page.
create or replace function public.my_storage_bytes()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects
  where bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.uid())::text
$$;
revoke execute on function public.my_storage_bytes() from public, anon;
grant execute on function public.my_storage_bytes() to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: changes to your jumps (from another device) and new comments reach open apps.
-- Realtime applies the same row rules, so nobody hears about rows they can't read.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'jumps') then
      alter publication supabase_realtime add table public.jumps;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'jump_comments') then
      alter publication supabase_realtime add table public.jump_comments;
    end if;
  end if;
end $$;
