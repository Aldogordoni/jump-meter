// Generated from the Supabase schema. Regenerate after a migration:
//   npm run db:types   (needs the Supabase CLI and `supabase login`)
// or with the Supabase MCP tool "generate_typescript_types".

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '14.18';
  };
  public: {
    Tables: {
      allowed_emails: {
        Row: { added_at: string; added_by: string | null; email: string; is_admin: boolean; note: string | null };
        Insert: { added_at?: string; added_by?: string | null; email: string; is_admin?: boolean; note?: string | null };
        Update: { added_at?: string; added_by?: string | null; email?: string; is_admin?: boolean; note?: string | null };
        Relationships: [];
      };
      allowlist_audit: {
        Row: {
          action: string; actor_email: string | null; actor_id: string | null; at: string; email: string; id: number;
          is_admin: boolean | null; note: string | null;
        };
        Insert: {
          action: string; actor_email?: string | null; actor_id?: string | null; at?: string; email: string; id?: never;
          is_admin?: boolean | null; note?: string | null;
        };
        Update: {
          action?: string; actor_email?: string | null; actor_id?: string | null; at?: string; email?: string; id?: never;
          is_admin?: boolean | null; note?: string | null;
        };
        Relationships: [];
      };
      client_errors: {
        Row: {
          app_version: string | null; at: string; id: number; message: string; path: string | null; stack: string | null;
          user_agent: string | null; user_id: string | null;
        };
        Insert: {
          app_version?: string | null; at?: string; id?: never; message: string; path?: string | null; stack?: string | null;
          user_agent?: string | null; user_id?: string | null;
        };
        Update: {
          app_version?: string | null; at?: string; id?: never; message?: string; path?: string | null; stack?: string | null;
          user_agent?: string | null; user_id?: string | null;
        };
        Relationships: [];
      };
      jump_comments: {
        Row: { author_id: string; body: string; created_at: string; id: string; jump_id: string };
        Insert: { author_id?: string; body: string; created_at?: string; id?: string; jump_id: string };
        Update: { author_id?: string; body?: string; created_at?: string; id?: string; jump_id?: string };
        Relationships: [
          { foreignKeyName: 'jump_comments_jump_id_fkey'; columns: ['jump_id']; isOneToOne: false; referencedRelation: 'jumps'; referencedColumns: ['id'] },
        ];
      };
      jumps: {
        Row: {
          box_cm: number | null; capture_fps: number; contact_ms: number | null; created_at: string; extra: Json; flight_ms: number;
          frames: number; has_clip: boolean; height_cm: number; id: string; jumped_at: string; method: string; note: string | null;
          rsi: number | null; rsi_mod: number | null; session_id: string | null; tags: string[]; time_to_takeoff_ms: number | null;
          type: string; updated_at: string; user_id: string;
        };
        Insert: {
          box_cm?: number | null; capture_fps: number; contact_ms?: number | null; created_at?: string; extra?: Json; flight_ms: number;
          frames: number; has_clip?: boolean; height_cm: number; id: string; jumped_at: string; method: string; note?: string | null;
          rsi?: number | null; rsi_mod?: number | null; session_id?: string | null; tags?: string[]; time_to_takeoff_ms?: number | null;
          type: string; updated_at?: string; user_id?: string;
        };
        Update: {
          box_cm?: number | null; capture_fps?: number; contact_ms?: number | null; created_at?: string; extra?: Json; flight_ms?: number;
          frames?: number; has_clip?: boolean; height_cm?: number; id?: string; jumped_at?: string; method?: string; note?: string | null;
          rsi?: number | null; rsi_mod?: number | null; session_id?: string | null; tags?: string[]; time_to_takeoff_ms?: number | null;
          type?: string; updated_at?: string; user_id?: string;
        };
        Relationships: [];
      };
      login_attempts: {
        Row: { at: string; id: number; username: string };
        Insert: { at?: string; id?: never; username: string };
        Update: { at?: string; id?: never; username?: string };
        Relationships: [];
      };
      profiles: {
        Row: { avatar_path: string | null; display_name: string | null; settings: Json; updated_at: string; user_id: string; username: string | null };
        Insert: {
          avatar_path?: string | null; display_name?: string | null; settings?: Json; updated_at?: string; user_id?: string; username?: string | null;
        };
        Update: {
          avatar_path?: string | null; display_name?: string | null; settings?: Json; updated_at?: string; user_id?: string; username?: string | null;
        };
        Relationships: [];
      };
      squad_members: {
        Row: { joined_at: string; on_leaderboard: boolean; role: string; share_jumps: boolean; squad_id: string; user_id: string };
        Insert: { joined_at?: string; on_leaderboard?: boolean; role?: string; share_jumps?: boolean; squad_id: string; user_id?: string };
        Update: { joined_at?: string; on_leaderboard?: boolean; role?: string; share_jumps?: boolean; squad_id?: string; user_id?: string };
        Relationships: [
          { foreignKeyName: 'squad_members_squad_id_fkey'; columns: ['squad_id']; isOneToOne: false; referencedRelation: 'squads'; referencedColumns: ['id'] },
        ];
      };
      squads: {
        Row: { created_at: string; id: string; invite_code: string; name: string; owner_id: string };
        Insert: { created_at?: string; id?: string; invite_code?: string; name: string; owner_id?: string };
        Update: { created_at?: string; id?: string; invite_code?: string; name?: string; owner_id?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      can_see_jump: { Args: { jid: string }; Returns: boolean };
      coaches_user: { Args: { target: string }; Returns: boolean };
      errors_today: { Args: never; Returns: number };
      is_admin: { Args: never; Returns: boolean };
      is_allowed: { Args: never; Returns: boolean };
      is_squad_member: { Args: { sq: string }; Returns: boolean };
      is_squad_owner: { Args: { sq: string }; Returns: boolean };
      join_squad: { Args: { code: string }; Returns: string };
      jump_comment_authors: { Args: { jid: string }; Returns: { display_name: string; user_id: string; username: string }[] };
      mfa_ok: { Args: never; Returns: boolean };
      my_file_count: { Args: never; Returns: number };
      my_storage_bytes: { Args: never; Returns: number };
      new_invite_code: { Args: { sq: string }; Returns: string };
      shares_squad_with: { Args: { target: string }; Returns: boolean };
      squad_leaderboard: {
        Args: { jump_type: string; since: string; sq: string };
        Returns: {
          avatar_path: string; best_distance: number; best_height: number; best_rsi: number; display_name: string; jumps: number;
          last_jump: string; user_id: string; username: string;
        }[];
      };
      squad_roster: {
        Args: { sq: string };
        Returns: {
          avatar_path: string; display_name: string; joined_at: string; on_leaderboard: boolean; role: string; share_jumps: boolean;
          user_id: string; username: string;
        }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
