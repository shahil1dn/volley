import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The publishable key can only read visible words (see db/schema.sql), which
// is all the browser needs for live updates.
let client: SupabaseClient | null = null;

export function browserClient(): SupabaseClient {
  client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
  return client;
}
