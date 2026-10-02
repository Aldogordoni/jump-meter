/**
 * Supabase project for cloud sync. Both values are public by design: the publishable
 * key only lets a signed-in, whitelisted user reach their own rows, enforced by the
 * row-level security in supabase/migrations/.
 *
 * Leave empty to run the app in local-only mode.
 */
export const SUPABASE_URL = 'https://vpuvhkermemvkapbrngu.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_sCaWQFAppkHCu6377mvUZQ_gzdPilcs';

export const cloudConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
