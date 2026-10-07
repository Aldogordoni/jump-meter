-- Profile fields (username, display name, picture) and throttling for username sign-in.
-- Applied to the jump-meter project. The edge function is in supabase/functions/username-login.

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_path text;

alter table public.profiles add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9_.]{3,24}$');
alter table public.profiles add constraint profiles_display_name_length
  check (display_name is null or char_length(display_name) <= 60);
create unique index if not exists profiles_username_key on public.profiles (username);

-- Failed username sign-ins, used by the username-login edge function to slow down guessing.
-- RLS on with no policies: only the service role (inside the edge function) can touch it.
create table if not exists public.login_attempts (
  id         bigint generated always as identity primary key,
  username   text not null,
  at         timestamptz not null default now()
);
create index if not exists login_attempts_username_at on public.login_attempts (username, at desc);
alter table public.login_attempts enable row level security;
