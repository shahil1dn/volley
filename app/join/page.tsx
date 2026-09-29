'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function EnterCodePage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');

  return (
    <main className="narrow">
      <p className="label">AI Builders Live</p>
      <h1>Join a session.</h1>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/j/${cleaned}`);
        }}
      >
        <label className="field">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={5}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="5-letter code on the screen"
            aria-label="Session code"
          />
        </label>
        <button className="btn btn--block" disabled={cleaned.length !== 5}>Join</button>
      </form>
    </main>
  );
}
