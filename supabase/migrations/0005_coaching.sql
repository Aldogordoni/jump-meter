-- Coaching and squads: invite-only groups, coach access with athlete consent,
-- opt-in leaderboards, and comments on jumps.
--
-- Privacy model
--   * Joining a squad shares nothing by itself.
--   * An athlete's jumps and clips are visible to the squad's coaches only while the athlete
--     has "share_jumps" on. Only the athlete can change that (enforced by a trigger).
--   * Leaderboards only list members who turned "on_leaderboard" on, and only show bests.
--   * Profile settings (mass, goals…) are never exposed; rosters come from a function that
--     returns names and pictures only.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.squads (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at  timestamptz not null default now()
);
alter table public.squads enable row level security;

create table if not exists public.squad_members (
  squad_id       uuid not null references public.squads (id) on delete cascade,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role           text not null default 'athlete' check (role in ('coach', 'athlete')),
  share_jumps    boolean not null default false,
  on_leaderboard boolean not null default false,
  joined_at      timestamptz not null default now(),
  primary key (squad_id, user_id)
);
create index if not exists squad_members_user on public.squad_members (user_id);
alter table public.squad_members enable row level security;

create table if not exists public.jump_comments (
  id         uuid primary key default gen_random_uuid(),
  jump_id    uuid not null references public.jumps (id) on delete cascade,
  author_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists jump_comments_jump on public.jump_comments (jump_id, created_at);
alter table public.jump_comments enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers (security definer so policies don't recurse through squad_members RLS)
-- ---------------------------------------------------------------------------

create or replace function public.is_squad_member(sq uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.squad_members where squad_id = sq and user_id = (select auth.uid()))
$$;

create or replace function public.is_squad_owner(sq uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.squads where id = sq and owner_id = (select auth.uid()))
$$;

-- Am I a coach of a squad where this user shares their jumps?
create or replace function public.coaches_user(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.squad_members c
    join public.squad_members a on a.squad_id = c.squad_id
    where c.user_id = (select auth.uid()) and c.role = 'coach'
      and a.user_id = target and a.share_jumps
  )
$$;

-- Do I share any squad with this user? (for names and pictures)
create or replace function public.shares_squad_with(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.squad_members me
    join public.squad_members other on other.squad_id = me.squad_id
    where me.user_id = (select auth.uid()) and other.user_id = target
  )
$$;

revoke execute on function public.is_squad_member(uuid), public.is_squad_owner(uuid),
  public.coaches_user(uuid), public.shares_squad_with(uuid) from public, anon;
grant execute on function public.is_squad_member(uuid), public.is_squad_owner(uuid),
  public.coaches_user(uuid), public.shares_squad_with(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Squads
-- ---------------------------------------------------------------------------

drop policy if exists "squads: members read" on public.squads;
create policy "squads: members read" on public.squads for select to authenticated
  using ((select public.is_allowed()) and (owner_id = (select auth.uid()) or (select public.is_squad_member(id))));

drop policy if exists "squads: create own" on public.squads;
create policy "squads: create own" on public.squads for insert to authenticated
  with check ((select public.is_allowed()) and owner_id = (select auth.uid()));

drop policy if exists "squads: owner edits" on public.squads;
create policy "squads: owner edits" on public.squads for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "squads: owner removes" on public.squads;
create policy "squads: owner removes" on public.squads for delete to authenticated
  using (owner_id = (select auth.uid()));

-- The creator becomes the squad's first coach.
create or replace function public.squad_add_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.squad_members (squad_id, user_id, role) values (new.id, new.owner_id, 'coach')
  on conflict (squad_id, user_id) do update set role = 'coach';
  return new;
end $$;
drop trigger if exists squad_add_owner on public.squads;
create trigger squad_add_owner after insert on public.squads for each row execute function public.squad_add_owner();

-- Join with an invite code. Returns the squad id, or null for an unknown code.
create or replace function public.join_squad(code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare sq uuid;
begin
  if not public.is_allowed() then raise exception 'not allowed'; end if;
  select id into sq from public.squads where invite_code = upper(trim(code));
  if sq is null then return null; end if;
  insert into public.squad_members (squad_id, user_id) values (sq, (select auth.uid()))
  on conflict (squad_id, user_id) do nothing;
  return sq;
end $$;
revoke execute on function public.join_squad(text) from public, anon;
grant execute on function public.join_squad(text) to authenticated;

-- New invite code (owner only), e.g. after it leaked.
create or replace function public.new_invite_code(sq uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare c text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
begin
  update public.squads set invite_code = c where id = sq and owner_id = (select auth.uid());
  if not found then raise exception 'only the owner can do that'; end if;
  return c;
end $$;
revoke execute on function public.new_invite_code(uuid) from public, anon;
grant execute on function public.new_invite_code(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------

drop policy if exists "members: squad mates read" on public.squad_members;
create policy "members: squad mates read" on public.squad_members for select to authenticated
  using ((select public.is_allowed()) and (select public.is_squad_member(squad_id)));

-- You change your own consent; the owner changes roles. The trigger below keeps those apart.
drop policy if exists "members: self or owner update" on public.squad_members;
create policy "members: self or owner update" on public.squad_members for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_squad_owner(squad_id)))
  with check (user_id = (select auth.uid()) or (select public.is_squad_owner(squad_id)));

-- Leave a squad, or the owner removes someone. The owner can't leave (remove the squad instead).
drop policy if exists "members: leave or remove" on public.squad_members;
create policy "members: leave or remove" on public.squad_members for delete to authenticated
  using (
    (user_id = (select auth.uid()) and not (select public.is_squad_owner(squad_id)))
    or ((select public.is_squad_owner(squad_id)) and user_id <> (select auth.uid()))
  );

create or replace function public.guard_member_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid());
begin
  if new.squad_id <> old.squad_id or new.user_id <> old.user_id or new.joined_at <> old.joined_at then
    raise exception 'membership identity cannot change';
  end if;
  -- Consent belongs to the athlete alone.
  if (new.share_jumps <> old.share_jumps or new.on_leaderboard <> old.on_leaderboard) and me <> old.user_id then
    raise exception 'only the member can change their sharing';
  end if;
  -- Roles belong to the owner, and the owner stays a coach.
  if new.role <> old.role then
    if not exists (select 1 from public.squads where id = old.squad_id and owner_id = me) then
      raise exception 'only the owner can change roles';
    end if;
    if exists (select 1 from public.squads where id = old.squad_id and owner_id = old.user_id) then
      raise exception 'the owner is always a coach';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_member_update on public.squad_members;
create trigger guard_member_update before update on public.squad_members
  for each row execute function public.guard_member_update();

-- Names and pictures of my squad mates (never their settings).
create or replace function public.squad_roster(sq uuid)
returns table (
  user_id uuid, role text, share_jumps boolean, on_leaderboard boolean, joined_at timestamptz,
  display_name text, username text, avatar_path text
)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.role, m.share_jumps, m.on_leaderboard, m.joined_at,
         p.display_name, p.username, p.avatar_path
  from public.squad_members m
  left join public.profiles p on p.user_id = m.user_id
  where m.squad_id = sq and public.is_squad_member(sq) and public.is_allowed()
  order by m.role, coalesce(p.display_name, p.username)
$$;
revoke execute on function public.squad_roster(uuid) from public, anon;
grant execute on function public.squad_roster(uuid) to authenticated;

-- Opt-in leaderboard: each member's best since a date, for one jump type.
create or replace function public.squad_leaderboard(sq uuid, jump_type text, since timestamptz)
returns table (
  user_id uuid, display_name text, username text, avatar_path text,
  best_height real, best_rsi real, best_distance real, jumps bigint, last_jump timestamptz
)
language sql stable security definer set search_path = '' as $$
  select m.user_id, p.display_name, p.username, p.avatar_path,
         max(j.height_cm), max(j.rsi), max((j.extra ->> 'distanceCm')::real), count(j.id), max(j.jumped_at)
  from public.squad_members m
  left join public.profiles p on p.user_id = m.user_id
  join public.jumps j on j.user_id = m.user_id and j.type = jump_type and j.jumped_at >= since
  where m.squad_id = sq and m.on_leaderboard and public.is_squad_member(sq) and public.is_allowed()
  group by m.user_id, p.display_name, p.username, p.avatar_path
$$;
revoke execute on function public.squad_leaderboard(uuid, text, timestamptz) from public, anon;
grant execute on function public.squad_leaderboard(uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Coach access to athletes' jumps and clips (with consent)
-- ---------------------------------------------------------------------------

drop policy if exists "jumps: coaches read shared" on public.jumps;
create policy "jumps: coaches read shared" on public.jumps for select to authenticated
  using ((select public.is_allowed()) and public.coaches_user(user_id));

drop policy if exists "clips: coaches read shared" on storage.objects;
create policy "clips: coaches read shared" on storage.objects for select to authenticated
  using (
    bucket_id = 'clips' and (select public.is_allowed())
    and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.coaches_user(((storage.foldername(name))[1])::uuid) else false end
  );

drop policy if exists "clips: squad mates see pictures" on storage.objects;
create policy "clips: squad mates see pictures" on storage.objects for select to authenticated
  using (
    bucket_id = 'clips' and name like '%/avatar.jpg' and (select public.is_allowed())
    and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.shares_squad_with(((storage.foldername(name))[1])::uuid) else false end
  );

-- ---------------------------------------------------------------------------
-- Comments: the jump's owner and the coaches who can see it
-- ---------------------------------------------------------------------------

create or replace function public.can_see_jump(jid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.jumps j
    where j.id = jid and (j.user_id = (select auth.uid()) or public.coaches_user(j.user_id))
  )
$$;
revoke execute on function public.can_see_jump(uuid) from public, anon;
grant execute on function public.can_see_jump(uuid) to authenticated;

drop policy if exists "comments: read" on public.jump_comments;
create policy "comments: read" on public.jump_comments for select to authenticated
  using ((select public.is_allowed()) and public.can_see_jump(jump_id));

drop policy if exists "comments: write" on public.jump_comments;
create policy "comments: write" on public.jump_comments for insert to authenticated
  with check ((select public.is_allowed()) and author_id = (select auth.uid()) and public.can_see_jump(jump_id));

drop policy if exists "comments: author or jump owner removes" on public.jump_comments;
create policy "comments: author or jump owner removes" on public.jump_comments for delete to authenticated
  using (
    author_id = (select auth.uid())
    or exists (select 1 from public.jumps j where j.id = jump_id and j.user_id = (select auth.uid()))
  );

-- Comment authors' names for a jump I can see.
create or replace function public.jump_comment_authors(jid uuid)
returns table (user_id uuid, display_name text, username text)
language sql stable security definer set search_path = '' as $$
  select distinct c.author_id, p.display_name, p.username
  from public.jump_comments c left join public.profiles p on p.user_id = c.author_id
  where c.jump_id = jid and public.can_see_jump(jid)
$$;
revoke execute on function public.jump_comment_authors(uuid) from public, anon;
grant execute on function public.jump_comment_authors(uuid) to authenticated;

-- Trigger functions are not API endpoints.
revoke execute on function public.guard_member_update(), public.squad_add_owner() from public, anon, authenticated;
