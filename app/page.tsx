'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function StartPage() {
  const router = useRouter();
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (!response?.ok || !body?.code) {
      setError(body?.error ?? 'Could not start the session. Check your connection.');
      setBusy(false);
      return;
    }
    // The host key only ever lives on this laptop. Whoever holds it can hide words.
    localStorage.setItem(`host:${body.code}`, body.hostToken);
    router.push(`/host/${body.code}`);
  }

  return (
    <main className="narrow">
      <p className="label">AI Builders Live</p>
      <h1>Start a word cloud.</h1>
      <p className="hint">Ask one question. Everyone answers from their phone and the cloud grows live on your screen.</p>
      <form className="stack" onSubmit={start}>
        <label className="field">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={140}
            required
            placeholder="What comes to mind when you hear “AI”?"
            aria-label="Your question"
          />
        </label>
        <button className="btn btn--block" disabled={busy || !question.trim()}>
          {busy ? 'Starting…' : 'Start'}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      <p className="narrow__foot hint">
        Taking part? <a className="link" href="/join">Enter a code</a>
      </p>
    </main>
  );
}
