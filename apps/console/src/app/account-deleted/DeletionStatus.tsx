'use client';

import { useEffect, useState } from 'react';
import { Lang, strings } from '@/lib/i18n';

const POLL_MS = 5000;

type State =
  | { kind: 'loading' }
  | { kind: 'deleting' | 'failed'; deadline: string }
  | { kind: 'completed'; completedAt: string }
  | { kind: 'unknown' }
  | { kind: 'error' };

const when = (lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

/** Shows deleting / completed / failed from the API, and never says "done" before the purge has finished (Doc 17). */
export function DeletionStatus({ lang }: { lang: Lang }) {
  const t = strings(lang);
  const fmt = when(lang);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    document.documentElement.lang = lang;
    const ticket = window.location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      setState({ kind: 'unknown' });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch(`/bff/account-deletions/${ticket}`, { cache: 'no-store' });
        if (stopped) return;
        if (res.status === 404) return setState({ kind: 'unknown' });
        if (!res.ok) setState({ kind: 'error' });
        else {
          const body = (await res.json()) as { status: 'deleting' | 'completed' | 'failed'; deadline: string; completedAt: string | null };
          if (body.status === 'completed') return setState({ kind: 'completed', completedAt: body.completedAt! });
          setState({ kind: body.status, deadline: body.deadline });
        }
      } catch {
        if (!stopped) setState({ kind: 'error' });
      }
      if (!stopped) timer = setTimeout(check, POLL_MS);
    };
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [lang]);

  return (
    <main className="shell">
      <div className="nav">
        <span className="brand">{t.appName}</span>
      </div>
      <h1>{t.deletedTitle}</h1>
      <div aria-live="polite" data-testid="deletion-status">
        {state.kind === 'deleting' && <p className="lede">{t.deletedDeleting}</p>}
        {state.kind === 'failed' && (
          <div className="notice error">
            <p>{t.deletedFailed}</p>
          </div>
        )}
        {(state.kind === 'deleting' || state.kind === 'failed') && <p className="status">{t.deletedDeadline(fmt.format(new Date(state.deadline)))}</p>}
        {state.kind === 'completed' && <p className="lede">{t.deletedCompleted(fmt.format(new Date(state.completedAt)))}</p>}
        {state.kind === 'unknown' && <p className="lede">{t.deletedUnknown}</p>}
        {state.kind === 'error' && <p className="status">{t.deletedCheckError}</p>}
      </div>
      {state.kind !== 'completed' && state.kind !== 'unknown' && <p className="status">{t.deletedKeep}</p>}
      <p>
        <a href="/login">{t.deletedHome}</a>
      </p>
    </main>
  );
}
