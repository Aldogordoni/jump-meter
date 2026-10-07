alter table public.jumps add column if not exists session_id text;
alter table public.jumps add column if not exists tags text[] not null default '{}';
-- Analysis details: posture check, confidence, kinematics, hops, distances, reference device…
alter table public.jumps add column if not exists extra jsonb not null default '{}'::jsonb;
create index if not exists jumps_user_session on public.jumps (user_id, session_id);
