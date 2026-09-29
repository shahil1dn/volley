import { NextResponse } from 'next/server';
import { adminClient } from '@/lib/supabase-server';
import { CODE_PATTERN } from '@/lib/host-token';
import { MAX_WORD_LENGTH, normaliseWord } from '@/lib/words';

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE_PATTERN.test(code)) return NextResponse.json({ error: 'No such session.' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const word = typeof body?.word === 'string' ? normaliseWord(body.word) : null;
  if (!word) {
    return NextResponse.json({ error: `A word must be 1 to ${MAX_WORD_LENGTH} characters.` }, { status: 400 });
  }

  const db = adminClient();
  const { data: session } = await db.from('sessions').select('id').eq('code', code).maybeSingle();
  if (!session) return NextResponse.json({ error: 'No such session.' }, { status: 404 });

  const { error } = await db.from('words').insert({ session_id: session.id, text: word });
  if (error) return NextResponse.json({ error: 'Could not save that word.' }, { status: 500 });
  return NextResponse.json({ word }, { status: 201 });
}
