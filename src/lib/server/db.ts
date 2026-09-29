import { createClient } from '@supabase/supabase-js';
import { SUPABASE_SECRET_KEY, SUPABASE_URL } from '$env/static/private';

// The server's only way into the database. The secret key runs as service_role,
// the one role allowed to call get_state and submit_answer.
export const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
