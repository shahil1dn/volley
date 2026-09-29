import 'server-only';
import { createClient } from '@supabase/supabase-js';

// The secret key skips row-level security. `server-only` makes the build fail
// if any browser code ever imports this file.
export function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false } });
}
