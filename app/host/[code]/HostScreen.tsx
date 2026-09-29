'use client';

import QRCode from 'qrcode';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browserClient } from '@/lib/supabase-browser';
import { centreOut, countWords } from '@/lib/words';

type Props = { sessionId: string; code: string; question: string };
type WordRow = { id: number; text: string };

// The society's plum marks the most popular answer; everything else is ink
// or grey, picked by the word itself so it keeps its colour as the cloud
// reshuffles around it.
const TOP_COLOUR = '#4a2352';
const OTHER_COLOURS = ['#1e1622', '#5f5666'];

// Many distinct words need smaller type to fit one screen.
function largestSizeVw(distinctWords: number) {
  return Math.max(3.5, 8 - distinctWords * 0.08);
}
const SMALLEST_SIZE_VW = 1.4;
// Each shrink step, and the floor below which words would be unreadable anyway.
const FIT_STEP = 0.9;
const MIN_FIT = 0.2;

// Shrinks every word together until the cloud fits its box. Done on the DOM
// directly, before paint, so the room never sees a frame that overflows.
function fitToBox(cloud: HTMLElement) {
  let fit = 1;
  cloud.style.setProperty('--fit', String(fit));
  const overflows = () => cloud.scrollHeight > cloud.clientHeight || cloud.scrollWidth > cloud.clientWidth;
  while (overflows() && fit > MIN_FIT) {
    fit *= FIT_STEP;
    cloud.style.setProperty('--fit', String(fit));
  }
}

export default function HostScreen({ sessionId, code, question }: Props) {
  // Keyed by row id, so a word that arrives both live and in the first load
  // is only counted once.
  const [words, setWords] = useState<Map<number, string>>(new Map());
  const [live, setLive] = useState(false);
  const [joinUrl, setJoinUrl] = useState('');
  const [siteHost, setSiteHost] = useState('');
  const [qr, setQr] = useState('');
  const [hostToken, setHostToken] = useState<string | null>(null);

  useEffect(() => {
    setHostToken(localStorage.getItem(`host:${code}`));
    const url = `${location.origin}/j/${code}`;
    setJoinUrl(url);
    setSiteHost(location.host);
    QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#1e1622', light: '#ffffff' } }).then(setQr);
  }, [code]);

  useEffect(() => {
    const db = browserClient();
    const add = (rows: WordRow[]) =>
      setWords((prev) => {
        const next = new Map(prev);
        for (const row of rows) next.set(row.id, row.text);
        return next;
      });

    // Subscribe first, then load what is already there. Loading first would
    // miss any word sent in the gap before the subscription opened.
    const channel = db
      .channel(`words:${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'words', filter: `session_id=eq.${sessionId}` },
        (payload) => add([payload.new as WordRow]),
      )
      .subscribe(async (status) => {
        setLive(status === 'SUBSCRIBED');
        if (status !== 'SUBSCRIBED') return;
        const { data } = await db.from('words').select('id, text').eq('session_id', sessionId);
        if (data) add(data);
      });
    return () => {
      db.removeChannel(channel);
    };
  }, [sessionId]);

  const counts = useMemo(() => countWords([...words.values()]), [words]);
  const cloudRef = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    const cloud = cloudRef.current;
    if (!cloud) return;
    fitToBox(cloud);
    const observer = new ResizeObserver(() => fitToBox(cloud));
    observer.observe(cloud);
    return () => observer.disconnect();
  }, [counts]);
  const biggest = counts[0]?.count ?? 1;
  const largest = largestSizeVw(counts.length);

  async function hide(text: string) {
    if (!hostToken) return;
    const response = await fetch(`/api/sessions/${code}/hide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: text, hostToken }),
    }).catch(() => null);
    if (!response?.ok) return;
    setWords((prev) => new Map([...prev].filter(([, word]) => word !== text)));
  }

  return (
    <main className="host">
      <header className="host__top">
        <div>
          <p className="label">AI Builders Live</p>
          <h1 className="host__question">{question}</h1>
        </div>
        <div className="host__join">
          {qr && <img src={qr} alt={`QR code to join at ${joinUrl}`} />}
          <div>
            <p className="host__joinText">Scan, or go to</p>
            <p className="host__url">{siteHost}/join</p>
            <p className="host__code">{code}</p>
            <p className="host__count" aria-live="polite">
              {live ? `${words.size} ${words.size === 1 ? 'answer' : 'answers'}` : 'Connecting…'}
            </p>
          </div>
        </div>
      </header>

      {counts.length === 0 ? (
        <p className="cloud__empty">Answers will appear here as they come in.</p>
      ) : (
        <ul className="cloud" aria-label="Word cloud" ref={cloudRef}>
          {centreOut(counts).map(({ text, count }) => {
            const share = Math.sqrt(count / biggest);
            const style = {
              fontSize: `calc(var(--fit, 1) * ${SMALLEST_SIZE_VW + (largest - SMALLEST_SIZE_VW) * share}vw)`,
              color: count === biggest ? TOP_COLOUR : OTHER_COLOURS[text.length % OTHER_COLOURS.length],
            };
            return (
              <li key={text} className="cloud__word" style={style}>
                {hostToken ? (
                  <button type="button" onClick={() => hide(text)} title="Click to hide" aria-label={`Hide “${text}”, ${count}`}>
                    {text}
                  </button>
                ) : (
                  text
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
