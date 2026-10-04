'use client';

import { useState } from 'react';
import type { DiagnosticReport, DiagnosticsView } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';

const when = (lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function PrivacyView({ lang, csrfToken, view }: { lang: Lang; csrfToken: string; view: DiagnosticsView | null }) {
  const t = strings(lang);
  const [reports, setReports] = useState<DiagnosticReport[]>(view?.reports ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [problem, setProblem] = useState('');
  const fmt = when(lang);

  async function remove(id: string) {
    setBusy(id);
    setProblem('');
    try {
      const res = await fetch(`/bff/diagnostics/${id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrfToken } });
      if (res.status === 204 || res.status === 404) {
        setReports((r) => r.filter((x) => x.id !== id));
        setAnnounce(t.privacyDeleted);
      } else setProblem(res.status === 401 ? t.expired : res.status === 429 ? t.rateLimited : t.unavailable);
    } catch {
      setProblem(t.unavailable);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="shell">
      <div className="nav">
        <span className="brand">{t.appName}</span>
        <a href="/app/settings">{t.navSettings}</a>
        <a href="/app/privacy" aria-current="page">
          {t.navPrivacy}
        </a>
        <form method="post" action="/auth/logout">
          <input type="hidden" name="csrf" value={csrfToken} />
          <button type="submit">{t.signOut}</button>
        </form>
      </div>

      <h1>{t.privacyTitle}</h1>
      <p className="lede">{t.privacyLede}</p>
      {problem && (
        <div role="alert" className="notice error">
          <p>{problem}</p>
        </div>
      )}

      <section className="device" aria-labelledby="diag-title">
        <h2 id="diag-title">{view ? t.privacyRetention(view.retentionDays) : t.privacyTitle}</h2>
        {view === null && <p className="status">{t.privacyLoadError}</p>}
        {view !== null && reports.length === 0 && <p className="status">{t.privacyNone}</p>}
        {reports.length > 0 && (
          <ul className="devices">
            {reports.map((r) => (
              <li key={r.id} data-testid="report">
                <span className="device-name">{t.privacyReport(r.platform, r.eventCount)}</span>
                <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => remove(r.id)}>
                  {busy === r.id ? t.privacyDeleting : t.privacyDelete}
                </button>
                <span className="status">
                  {r.events.map((e) => `${(t[`event.${e.eventName}` as keyof typeof t] as string) ?? e.eventName} ×${e.count}`).join(' · ')}
                </span>
                <span className="status">{t.privacyWhen(fmt.format(new Date(r.receivedAt)), fmt.format(new Date(r.expiresAt)))}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </main>
  );
}
