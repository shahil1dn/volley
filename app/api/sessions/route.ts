import { NextResponse } from 'next/server';
import { adminClient } from '@/lib/supabase-server';
import { hashHostToken, makeHostToken, makeJoinCode } from '@/lib/host-token';

const MAX_QUESTION_LENGTH = 140;
// Five characters from a 32-letter alphabet is 33 million codes, so a clash is
// rare; retrying a few times makes it practically impossible to surface.
const CODE_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json({ error: `Question must be 1 to ${MAX_QUESTION_LENGTH} characters.` }, { status: 400 });
  }

  const hostToken = makeHostToken();
  const db = adminClient();
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = makeJoinCode();
    const { error } = await db
      .from('sessions')
      .insert({ code, question, host_token_hash: hashHostToken(hostToken) });
    if (!error) return NextResponse.json({ code, hostToken }, { status: 201 });
    if (error.code !== UNIQUE_VIOLATION) {
      return NextResponse.json({ error: 'Could not create the session.' }, { status: 500 });
    }
  }
  return NextResponse.json({ error: 'Could not create the session.' }, { status: 500 });
}
