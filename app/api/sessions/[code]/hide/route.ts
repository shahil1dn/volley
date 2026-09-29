import { NextResponse } from 'next/server';
import { adminClient } from '@/lib/supabase-server';
import { CODE_PATTERN, hostTokenMatches } from '@/lib/host-token';
import { normaliseWord } from '@/lib/words';

// Hides every copy of a word in the session, so one troll typed by several
// friends disappears in one click.
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE_PATTERN.test(code)) return NextResponse.json({ error: 'No such session.' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const hostToken = typeof body?.hostToken === 'string' ? body.hostToken : '';
  const word = typeof body?.word === 'string' ? normaliseWord(body.word) : null;
  if (!word || !hostToken) return NextResponse.json({ error: 'Bad request.' }, { status: 400 });

  const db = adminClient();
  const { data: session } = await db
    .from('sessions')
    .select('id, host_token_hash')
    .eq('code', code)
    .maybeSingle();
  // Same answer for "no session" and "wrong key", so guessing codes learns nothing.
  if (!session || !hostTokenMatches(hostToken, session.host_token_hash)) {
    return NextResponse.json({ error: 'Only the host can hide words.' }, { status: 403 });
  }

  const { error } = await db
    .from('words')
    .update({ hidden: true })
    .eq('session_id', session.id)
    .eq('text', word);
  if (error) return NextResponse.json({ error: 'Could not hide that word.' }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
