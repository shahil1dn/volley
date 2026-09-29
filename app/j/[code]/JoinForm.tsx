'use client';

import { useEffect, useState } from 'react';
import { MAX_WORD_LENGTH, WORDS_PER_PERSON } from '@/lib/words';

type Props = { code: string; question: string };

export default function JoinForm({ code, question }: Props) {
  const [word, setWord] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The limit lives on the phone for now, so it stops casual spamming but not a
  // determined person clearing their browser. The host's hide button covers that.
  const storageKey = `sent:${code}`;

  useEffect(() => {
    try {
      setSent(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
    } catch {}
  }, [storageKey]);

  const remaining = WORDS_PER_PERSON - sent.length;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const response = await fetch(`/api/sessions/${code}/words`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word }),
    }).catch(() => null);
    const body = await response?.json().catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError(body?.error ?? 'That did not send. Check your connection and try again.');
      return;
    }
    const next = [...sent, body.word];
    setSent(next);
    setWord('');
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  }

  return (
    <main className="narrow">
      <p className="label">AI Builders Live · {code}</p>
      <h1>{question}</h1>

      {remaining > 0 ? (
        <form className="stack" onSubmit={send}>
          <label className="field">
            <input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              maxLength={MAX_WORD_LENGTH}
              required
              autoComplete="off"
              enterKeyHint="send"
              placeholder="A word or short phrase"
              aria-label="Your answer"
            />
          </label>
          <button className="btn btn--block" disabled={busy || !word.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="hint" aria-live="polite">
            {sent.length === 0
              ? `You can send up to ${WORDS_PER_PERSON}.`
              : `Sent: ${sent.join(', ')}. ${remaining} left.`}
          </p>
        </form>
      ) : (
        <p className="hint narrow__foot" aria-live="polite">
          Thanks. Your answers ({sent.join(', ')}) are on the screen.
        </p>
      )}
    </main>
  );
}
