-- Optional: lets a user delete their own login from the Account page.
-- Without it, "Delete my cloud account" still removes all jumps, settings and clips,
-- but the bare login (email address) stays until an admin removes it under
-- Authentication → Users in the Supabase dashboard.
--
-- Paste into Supabase → SQL Editor → Run.

-- Delete your own account. Cascades to jumps and profile.
-- (The app removes your clip files from storage first.)
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

