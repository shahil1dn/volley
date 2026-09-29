import 'server-only';
import { adminClient } from '@/lib/supabase-server';
import { CODE_PATTERN } from '@/lib/host-token';

export type Session = { id: string; code: string; question: string };

// Never selects the host key hash, so it cannot leak into a rendered page.
export async function findSession(code: string): Promise<Session | null> {
  if (!CODE_PATTERN.test(code)) return null;
  const { data } = await adminClient()
    .from('sessions')
    .select('id, code, question')
    .eq('code', code)
    .maybeSingle();
  return data;
}
