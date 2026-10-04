'use client';

import { useEffect, useRef, useState } from 'react';
import type { DiagnosticReport, DiagnosticsView } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { AppNav } from '../AppNav';

const when = (lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function PrivacyView({
  lang,
  csrfToken,
  view,
  pendingDelete = false,
  reauthFailed = false,
}: {
  lang: Lang;
  csrfToken: string;
  view: DiagnosticsView | null;
  /** The user chose "delete this account" before being sent to re-authenticate. */
  pendingDelete?: boolean;
  reauthFailed?: boolean;
}) {
  const t = strings(lang);
  const [reports, setReports] = useState<DiagnosticReport[]>(view?.reports ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [problem, setProblem] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(pendingDelete || reauthFailed);
  const [understood, setUnderstood] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<'reauth' | 'reauthFailed' | 'expired' | 'rateLimited' | 'unavailable' | null>(
    reauthFailed ? 'reauthFailed' : null,
  );
  const checkRef = useRef<HTMLInputElement>(null);
  const fmt = when(lang);

  useEffect(() => {
    // Drop ?delete= and ?reauth= so a reload does not reopen the confirmation.
    if (pendingDelete || reauthFailed) window.history.replaceState(null, '', '/app/privacy');
  }, [pendingDelete, reauthFailed]);
  useEffect(() => {
    if (confirmingDelete) checkRef.current?.focus();
  }, [confirmingDelete]);

  async function deleteAccount() {
    setDeleting(true);
    setDeleteProblem(null);
    try {
      const res = await fetch('/bff/account', { method: 'DELETE', headers: { 'x-csrf-token': csrfToken } });
      if (res.status === 202) {
        const { ticket } = (await res.json()) as { ticket: string };
        // The ticket goes in the fragment, so it never reaches a server log.
        window.location.assign(`/account-deleted?lang=${lang}#${ticket}`);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (res.status === 401 && body.code === 'REAUTH_REQUIRED') setDeleteProblem('reauth');
      else if (res.status === 401) setDeleteProblem('expired');
      else setDeleteProblem(res.status === 429 ? 'rateLimited' : 'unavailable');
      setDeleting(false);
    } catch {
      setDeleteProblem('unavailable');
      setDeleting(false);
    }
  }

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
      <AppNav lang={lang} current="/app/privacy" csrfToken={csrfToken} />

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
      <section className="device" aria-labelledby="export-title">
        <h2 id="export-title">{t.exportTitle}</h2>
        <p className="status">{t.exportText}</p>
        <p>
          <a className="btn secondary" href="/bff/account/export" download>
            {t.exportGo}
          </a>
        </p>
      </section>

      <section className="device" aria-labelledby="delete-title">
        <h2 id="delete-title">{t.deleteTitle}</h2>
        <p className="status">{t.deleteText}</p>
        {deleteProblem && (
          <div role="alert" className="notice error">
            {deleteProblem === 'reauth' && <p>{t.deleteReauth}</p>}
            {deleteProblem === 'reauthFailed' && <p>{t.reauthFailed}</p>}
            {deleteProblem === 'expired' && <p>{t.expired}</p>}
            {deleteProblem === 'rateLimited' && <p>{t.rateLimited}</p>}
            {deleteProblem === 'unavailable' && <p>{t.unavailable}</p>}
            {(deleteProblem === 'reauth' || deleteProblem === 'reauthFailed') && (
              <a className="btn" href={`/auth/login?reauth=1&returnTo=${encodeURIComponent('/app/privacy?delete=1')}`}>
                {t.reauthGo}
              </a>
            )}
          </div>
        )}
        {confirmingDelete ? (
          <div className="confirm-delete" role="group" aria-label={t.deleteTitle}>
            <label>
              <input type="checkbox" ref={checkRef} checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              {t.deleteConfirmCheck}
            </label>
            <div className="row">
              <button type="button" className="btn danger" disabled={!understood || deleting} onClick={deleteAccount}>
                {deleting ? t.deleting : t.deleteConfirmYes}
              </button>
              <button type="button" className="btn secondary" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                {t.deleteCancel}
              </button>
            </div>
          </div>
        ) : (
          <p>
            <button type="button" className="btn secondary" onClick={() => setConfirmingDelete(true)}>
              {t.deleteGo}
            </button>
          </p>
        )}
      </section>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </main>
  );
}
