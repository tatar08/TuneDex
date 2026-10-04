'use client';

import { useEffect, useRef, useState } from 'react';
import type { DeviceView, SettingsView } from '@/lib/bff';
import { strings } from '@/lib/i18n';
import { AppNav } from '../AppNav';

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
  | { kind: 'unavailable' }
  | { kind: 'rateLimited' };

/** Last-seen times are shown in Thailand time whatever the browser's zone, so staff and users read the same clock. */
const seenFormat = (lang: string) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

export function SettingsForm({
  initial,
  devices,
  csrfToken,
}: {
  initial: SettingsView;
  /** Null when the device list could not be loaded. */
  devices: DeviceView[] | null;
  csrfToken: string;
}) {
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
      } else if (res.status === 429) {
        setProblem({ kind: 'rateLimited' });
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
      <AppNav lang={saved.settings.language} current="/app/settings" csrfToken={csrfToken} />

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
          {problem.kind === 'rateLimited' && <p>{t.rateLimited}</p>}
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
        {devices === null && <p className="status">{t.devicesLoadError}</p>}
        {devices?.filter((d) => !d.revokedAt).length === 0 && <p className="status">{t.devicesNone(saved.revision)}</p>}
        {devices && devices.some((d) => !d.revokedAt) && (
          <ul className="devices">
            {devices
              .filter((d) => !d.revokedAt)
              .map((d) => {
                const current = d.appliedSettingsRevision >= saved.revision;
                return (
                  <li key={d.id} data-testid="device">
                    <span className="device-name">{t.deviceName(d.platform, d.osMajor)}</span>
                    <span className={`chip${current ? ' ok' : ''}`}>{current ? t.deviceApplied : t.devicePending}</span>
                    <span className="status">
                      {t.deviceDetail(d.appliedSettingsRevision, d.appBuild, seenFormat(saved.settings.language).format(new Date(d.lastSeenAt)))}
                    </span>
                  </li>
                );
              })}
          </ul>
        )}
        <p>
          <a href="/app/devices">{t.devicesManage}</a>
        </p>
      </section>
    </main>
  );
}
