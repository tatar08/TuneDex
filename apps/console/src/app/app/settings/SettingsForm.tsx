'use client';

import { useEffect, useRef, useState } from 'react';
import type { SettingsView } from '@/lib/bff';
import { strings } from '@/lib/i18n';

type Values = SettingsView['settings'];
type Field = keyof Values;

const OPTIONS: Record<Field, string[]> = {
  theme: ['system', 'light', 'dark'],
  language: ['th', 'en'],
  cellularPolicy: ['allow', 'wifi_only'],
};

type Problem =
  | { kind: 'conflict'; server: SettingsView | null; currentRevision: number }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'unavailable' };

export function SettingsForm({ initial, csrfToken }: { initial: SettingsView; csrfToken: string }) {
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<Values>(initial.settings);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [announce, setAnnounce] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);

  const t = strings(saved.settings.language);
  const dirty = (Object.keys(values) as Field[]).some((k) => values[k] !== saved.settings[k]);

  useEffect(() => {
    document.documentElement.lang = saved.settings.language;
  }, [saved.settings.language]);
  useEffect(() => {
    if (problem) alertRef.current?.focus();
  }, [problem]);

  /** Sends only the fields that differ from `base`, the values this user started editing from. */
  async function save(revision: number, base: Values = saved.settings) {
    const patch: Partial<Values> = {};
    for (const k of Object.keys(values) as Field[]) if (values[k] !== base[k]) patch[k] = values[k] as never;
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/bff/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': `"${revision}"`, 'x-csrf-token': csrfToken },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setSaved(body as SettingsView);
        setValues((body as SettingsView).settings);
        setAnnounce(strings((body as SettingsView).settings.language).savedRevision((body as SettingsView).revision));
      } else if (res.status === 412) {
        const latest = await fetch('/bff/settings').then((r) => (r.ok ? (r.json() as Promise<SettingsView>) : null)).catch(() => null);
        setProblem({ kind: 'conflict', server: latest, currentRevision: latest?.revision ?? body?.details?.currentRevision ?? revision });
      } else if (res.status === 401) {
        setProblem({ kind: 'expired' });
      } else if (res.status === 400) {
        setProblem({ kind: 'invalid' });
      } else {
        setProblem({ kind: 'unavailable' });
      }
    } catch {
      setProblem({ kind: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }

  function useServer() {
    if (problem?.kind !== 'conflict' || !problem.server) return;
    setSaved(problem.server);
    setValues(problem.server.settings);
    setProblem(null);
    setAnnounce(strings(problem.server.settings.language).savedRevision(problem.server.revision));
  }

  function keepMine() {
    if (problem?.kind !== 'conflict') return;
    // Rebase: resend only the fields this user changed since the revision they started from,
    // so independent changes made elsewhere (other fields) survive. Same-field changes are the user's call.
    const { currentRevision, server } = problem;
    const startedFrom = saved.settings;
    if (server) setSaved(server);
    void save(currentRevision, startedFrom);
  }

  return (
    <main className="shell">
      <div className="nav">
        <span className="brand">{t.appName}</span>
        <form method="post" action="/auth/logout">
          <input type="hidden" name="csrf" value={csrfToken} />
          <button type="submit">{t.signOut}</button>
        </form>
      </div>

      <h1>{t.settingsTitle}</h1>
      <p className="lede">{t.settingsLede}</p>

      {problem && (
        <div ref={alertRef} tabIndex={-1} role="alert" className={`notice${problem.kind === 'conflict' ? '' : ' error'}`}>
          {problem.kind === 'conflict' && (
            <>
              <strong>{t.conflictTitle}</strong>
              <p>{t.conflictText(problem.currentRevision)}</p>
              <div className="row">
                {problem.server && (
                  <button type="button" className="btn secondary" onClick={useServer}>
                    {t.conflictUseServer}
                  </button>
                )}
                <button type="button" className="btn" onClick={keepMine} disabled={busy}>
                  {t.conflictKeepMine}
                </button>
              </div>
            </>
          )}
          {problem.kind === 'invalid' && <p>{t.invalid}</p>}
          {problem.kind === 'unavailable' && <p>{t.unavailable}</p>}
          {problem.kind === 'expired' && (
            <p>
              {t.expired} <a href="/auth/login?returnTo=/app/settings">{t.signIn}</a>
            </p>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(saved.revision);
        }}
      >
        {(Object.keys(OPTIONS) as Field[]).map((field) => (
          <fieldset key={field}>
            <legend>{t[field]}</legend>
            <div className="options">
              {OPTIONS[field].map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={field}
                    value={value}
                    checked={values[field] === value}
                    onChange={() => setValues((v) => ({ ...v, [field]: value }))}
                  />
                  {t[`${field}.${value}` as keyof typeof t] as string}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <div className="actions">
          <button type="submit" className="btn" disabled={busy || !dirty}>
            {busy ? t.saving : t.save}
          </button>
          <span className="status" data-testid="saved-revision">
            {saved.revision > 0 ? t.savedRevision(saved.revision) : t.neverSaved}
          </span>
        </div>
      </form>
      <p className="sr-only" aria-live="polite">{announce}</p>

      <section className="device" aria-labelledby="device-title">
        <h2 id="device-title">{t.deviceTitle}</h2>
        <span className="chip">{t.devicePending}</span>
        <p className="status">{t.deviceText(saved.revision)}</p>
      </section>
    </main>
  );
}
