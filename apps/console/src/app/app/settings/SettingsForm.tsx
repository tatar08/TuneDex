'use client';

import { useEffect, useRef, useState } from 'react';
import type { DevicePreferencesView, DeviceView, SettingsView } from '@/lib/bff';
import { accountLang, strings, type Lang } from '@/lib/i18n';
import { AppNav } from '../AppNav';

type Values = SettingsView['settings'];
type Field = keyof Values;

const OPTIONS: Record<Field, string[]> = {
  theme: ['system', 'light', 'dark'],
  language: ['th', 'en', 'system'],
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

/** Doc 17 /app/settings device overrides: one device can differ from the account; the preview shows what it will use. */
function DeviceOverrides({ device, account, lang, csrfToken, onAnnounce }: { device: DeviceView; account: Values; lang: Lang; csrfToken: string; onAnnounce: (s: string) => void }) {
  const t = strings(lang);
  const [saved, setSaved] = useState({ overrides: device.overrides, revision: device.preferencesRevision });
  const [draft, setDraft] = useState<Partial<Values>>(device.overrides);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const label = (field: Field, value: string) => t[`${field}.${value}` as keyof typeof t] as string;
  const effective = { ...account, ...draft } as Values;
  const dirty = JSON.stringify(Object.entries(draft).sort()) !== JSON.stringify(Object.entries(saved.overrides).sort());

  async function put(overrides: Partial<Values>) {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch(`/bff/devices/${device.id}/preferences`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': `"${saved.revision}"`, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ overrides }),
      });
      if (res.ok) {
        const v = (await res.json()) as DevicePreferencesView;
        setSaved({ overrides: v.overrides, revision: v.revision });
        setDraft(v.overrides);
        onAnnounce(t.overrideSaved);
      } else if (res.status === 412) {
        const latest = await fetch(`/bff/devices/${device.id}/preferences`).then((r) => (r.ok ? (r.json() as Promise<DevicePreferencesView>) : null)).catch(() => null);
        if (latest) {
          setSaved({ overrides: latest.overrides, revision: latest.revision });
          setDraft(latest.overrides);
        }
        setProblem(t.overrideConflict);
      } else setProblem(res.status === 401 ? t.expired : res.status === 429 ? t.rateLimited : t.unavailable);
    } catch {
      setProblem(t.unavailable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="overrides" open={Object.keys(saved.overrides).length > 0}>
      <summary>{t.overrideTitle}</summary>
      {problem && (
        <p role="alert" className="notice error">
          {problem}
        </p>
      )}
      {(Object.keys(OPTIONS) as Field[]).map((field) => (
        <label key={field} className="override-field">
          <span>{t[field]}</span>
          <select
            value={draft[field] ?? ''}
            onChange={(e) =>
              setDraft((d) => {
                const next = { ...d };
                if (e.target.value) next[field] = e.target.value;
                else delete next[field];
                return next;
              })
            }
          >
            <option value="">{t.overrideFollow(label(field, account[field]))}</option>
            {OPTIONS[field].map((value) => (
              <option key={value} value={value}>
                {label(field, value)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p className="status" data-testid="effective">
        {t.overrideEffective((Object.keys(OPTIONS) as Field[]).map((f) => label(f, effective[f])).join(' · '))}
      </p>
      <div className="row">
        <button type="button" className="btn secondary" disabled={busy || !dirty} onClick={() => void put(draft)}>
          {t.overrideSave}
        </button>
        {Object.keys(saved.overrides).length > 0 && (
          <button type="button" className="btn secondary" disabled={busy} onClick={() => void put({})}>
            {t.overrideReset}
          </button>
        )}
      </div>
    </details>
  );
}

export function SettingsForm({
  initial,
  devices,
  csrfToken,
  browserLang = 'th',
}: {
  initial: SettingsView;
  /** Null when the device list could not be loaded. */
  devices: DeviceView[] | null;
  csrfToken: string;
  /** What 'system' resolves to: the browser's Accept-Language, read on the server so the first render matches. */
  browserLang?: Lang;
}) {
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<Values>(initial.settings);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [announce, setAnnounce] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);

  const lang = accountLang(saved.settings.language, browserLang);
  const t = strings(lang);
  const dirty = (Object.keys(values) as Field[]).some((k) => values[k] !== saved.settings[k]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    if (problem) alertRef.current?.focus();
  }, [problem]);

  /**
   * Sends only the fields that differ from `base`, the values this user started editing from.
   * Doc 06/17: when someone else saved meanwhile, fields only one side changed are rebased and sent again
   * once without asking; only a field both sides changed to different values goes to the user.
   */
  async function save(revision: number, base: Values = saved.settings, rebased = false) {
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
        setAnnounce(strings(accountLang((body as SettingsView).settings.language, browserLang)).savedRevision((body as SettingsView).revision));
      } else if (res.status === 412) {
        const latest = await fetch('/bff/settings').then((r) => (r.ok ? (r.json() as Promise<SettingsView>) : null)).catch(() => null);
        if (latest && !rebased && !Object.keys(patch).some((k) => latest.settings[k as Field] !== base[k as Field] && latest.settings[k as Field] !== patch[k as Field])) {
          setSaved(latest);
          return void (await save(latest.revision, base, true));
        }
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
    setAnnounce(strings(accountLang(problem.server.settings.language, browserLang)).savedRevision(problem.server.revision));
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
      <AppNav lang={lang} current="/app/settings" csrfToken={csrfToken} />

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
                      {t.deviceDetail(d.appliedSettingsRevision, d.appBuild, seenFormat(lang).format(new Date(d.lastSeenAt)))}
                    </span>
                    <DeviceOverrides device={d} account={saved.settings} lang={lang} csrfToken={csrfToken} onAnnounce={setAnnounce} />
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
