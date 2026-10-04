'use client';

import { useEffect, useRef, useState } from 'react';
import type { DeviceView } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { AppNav } from '../AppNav';

type Problem = 'reauth' | 'reauthFailed' | 'expired' | 'rateLimited' | 'unavailable' | 'gone';

/** Times read in Thailand time whatever the browser's zone, like the settings page. */
const when = (lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

export function DevicesView({
  lang,
  csrfToken,
  devices: initial,
  pendingRevoke,
  reauthFailed,
}: {
  lang: Lang;
  csrfToken: string;
  /** Null when the list could not be loaded. */
  devices: DeviceView[] | null;
  /** A device the user chose to sign out before being sent to re-authenticate. */
  pendingRevoke: string | null;
  reauthFailed: boolean;
}) {
  const t = strings(lang);
  const fmt = when(lang);
  const [devices, setDevices] = useState<DeviceView[]>(initial ?? []);
  const [confirming, setConfirming] = useState<string | null>(
    pendingRevoke && initial?.some((d) => d.id === pendingRevoke && !d.revokedAt) ? pendingRevoke : null,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ kind: Problem; deviceId?: string } | null>(reauthFailed ? { kind: 'reauthFailed', deviceId: pendingRevoke ?? undefined } : null);
  const [announce, setAnnounce] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const active = devices.filter((d) => !d.revokedAt);
  const revoked = devices.filter((d) => d.revokedAt);
  const name = (d: DeviceView) => t.deviceName(d.platform, d.osMajor);

  useEffect(() => {
    document.documentElement.lang = lang;
    // Drop ?revoke= and ?reauth= so a reload does not reopen the confirmation.
    if (pendingRevoke || reauthFailed) window.history.replaceState(null, '', '/app/devices');
  }, [lang, pendingRevoke, reauthFailed]);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (problem) alertRef.current?.focus();
  }, [problem]);

  async function revoke(d: DeviceView) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/bff/devices/${d.id}/session`, { method: 'DELETE', headers: { 'x-csrf-token': csrfToken } });
      if (res.ok) {
        const updated = (await res.json()) as DeviceView;
        setDevices((all) => all.map((x) => (x.id === d.id ? updated : x)));
        setConfirming(null);
        setAnnounce(t.deviceRevokedDone(name(d)));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      setConfirming(null);
      if (res.status === 401 && body.code === 'REAUTH_REQUIRED') setProblem({ kind: 'reauth', deviceId: d.id });
      else if (res.status === 401) setProblem({ kind: 'expired' });
      else if (res.status === 404) {
        setDevices((all) => all.filter((x) => x.id !== d.id));
        setProblem({ kind: 'gone' });
      } else setProblem({ kind: res.status === 429 ? 'rateLimited' : 'unavailable' });
    } catch {
      setProblem({ kind: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }

  const reauthHref = (deviceId?: string) =>
    `/auth/login?reauth=1&returnTo=${encodeURIComponent(deviceId ? `/app/devices?revoke=${deviceId}` : '/app/devices')}`;

  return (
    <main className="shell">
      <AppNav lang={lang} current="/app/devices" csrfToken={csrfToken} />
      <h1>{t.devicesTitle}</h1>
      <p className="lede">{t.devicesLede}</p>

      {problem && (
        <div role="alert" className="notice error" tabIndex={-1} ref={alertRef}>
          {problem.kind === 'reauth' && <p>{t.reauthNeeded}</p>}
          {problem.kind === 'reauthFailed' && <p>{t.reauthFailed}</p>}
          {problem.kind === 'expired' && <p>{t.expired}</p>}
          {problem.kind === 'rateLimited' && <p>{t.rateLimited}</p>}
          {problem.kind === 'unavailable' && <p>{t.unavailable}</p>}
          {problem.kind === 'gone' && <p>{t.deviceGone}</p>}
          {(problem.kind === 'reauth' || problem.kind === 'reauthFailed') && (
            <a className="btn" href={reauthHref(problem.deviceId)}>
              {t.reauthGo}
            </a>
          )}
          {problem.kind === 'expired' && <a href="/login?returnTo=/app/devices">{t.signIn}</a>}
        </div>
      )}

      <section className="device" aria-labelledby="active-title">
        <h2 id="active-title">{t.devicesActive}</h2>
        {initial === null && <p className="status">{t.devicesListError}</p>}
        {initial !== null && active.length === 0 && <p className="status">{t.devicesEmpty}</p>}
        {active.length > 0 && (
          <ul className="devices">
            {active.map((d) => (
              <li key={d.id} data-testid="device">
                <span className="device-name">{name(d)}</span>
                {confirming === d.id ? (
                  <span className="confirm" role="group" aria-label={t.deviceRevoke}>
                    <span className="status">{t.deviceRevokeConfirm(name(d))}</span>
                    <button type="button" className="btn danger" ref={confirmRef} disabled={busy} onClick={() => revoke(d)}>
                      {busy ? t.deviceRevoking : t.deviceRevokeYes}
                    </button>
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirming(null)}>
                      {t.deviceRevokeNo}
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirming(d.id)}>
                    {t.deviceRevoke}
                  </button>
                )}
                <span className="status">{t.deviceSeen(d.appBuild, fmt.format(new Date(d.lastSeenAt)))}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 && (
        <section className="device" aria-labelledby="revoked-title">
          <h2 id="revoked-title">{t.devicesRevoked}</h2>
          <ul className="devices">
            {revoked.map((d) => (
              <li key={d.id} data-testid="revoked-device">
                <span className="device-name">{name(d)}</span>
                <span className="status">{t.deviceRevokedAt(fmt.format(new Date(d.revokedAt!)))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </main>
  );
}
