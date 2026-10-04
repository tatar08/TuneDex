'use client';

import { useEffect, useRef, useState } from 'react';
import type { DiagnosticReport, DiagnosticsView, ExportJob, SupportGrant } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { AppNav } from '../AppNav';

const when = (lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function PrivacyView({
  lang,
  csrfToken,
  view,
  pendingDelete = false,
  pendingExport = false,
  reauthFailed = false,
}: {
  lang: Lang;
  csrfToken: string;
  view: DiagnosticsView | null;
  /** The user chose "delete this account" before being sent to re-authenticate. */
  pendingDelete?: boolean;
  /** The user chose "prepare my data" before being sent to re-authenticate. */
  pendingExport?: boolean;
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
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [exportProblem, setExportProblem] = useState<'reauth' | 'failed' | 'gone' | 'expired' | 'rateLimited' | 'unavailable' | null>(null);
  const [exportStarting, setExportStarting] = useState(false);
  const checkRef = useRef<HTMLInputElement>(null);
  const fmt = when(lang);

  useEffect(() => {
    // Drop ?delete= and ?reauth= so a reload does not reopen the confirmation.
    if (pendingDelete || pendingExport || reauthFailed) window.history.replaceState(null, '', '/app/privacy');
  }, [pendingDelete, pendingExport, reauthFailed]);
  useEffect(() => {
    if (pendingExport) void startExport();
    // Once, on arrival back from re-authentication.
  }, []);
  useEffect(() => {
    // Poll while the file is being built; it usually takes a few seconds.
    if (exportJob?.status !== 'pending') return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/bff/account/exports/${exportJob.id}`);
        if (res.ok) {
          const job = (await res.json()) as ExportJob;
          setExportJob(job);
          if (job.status === 'failed') setExportProblem('failed');
          if (job.status === 'ready') setAnnounce(t.exportReady(fmt.format(new Date(job.expiresAt))));
        } else if (res.status === 404) {
          setExportJob(null);
          setExportProblem('gone');
        } else if (res.status === 401) {
          setExportJob(null);
          setExportProblem('expired');
        } else setExportJob({ ...exportJob }); // try again after the next wait
      } catch {
        setExportJob({ ...exportJob });
      }
    }, 2_000);
    return () => clearTimeout(timer);
  }, [exportJob, fmt, t]);

  async function startExport() {
    setExportStarting(true);
    setExportProblem(null);
    try {
      const res = await fetch('/bff/account/exports', { method: 'POST', headers: { 'x-csrf-token': csrfToken, 'idempotency-key': crypto.randomUUID() } });
      if (res.status === 202) {
        setExportJob((await res.json()) as ExportJob);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      if (res.status === 401 && body.code === 'REAUTH_REQUIRED') setExportProblem('reauth');
      else if (res.status === 401) setExportProblem('expired');
      else setExportProblem(res.status === 429 ? 'rateLimited' : 'unavailable');
    } catch {
      setExportProblem('unavailable');
    } finally {
      setExportStarting(false);
    }
  }
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
        {exportProblem && (
          <div role="alert" className="notice error">
            {exportProblem === 'reauth' && <p>{t.exportReauth}</p>}
            {exportProblem === 'failed' && <p>{t.exportFailed}</p>}
            {exportProblem === 'gone' && <p>{t.exportGone}</p>}
            {exportProblem === 'expired' && <p>{t.expired}</p>}
            {exportProblem === 'rateLimited' && <p>{t.rateLimited}</p>}
            {exportProblem === 'unavailable' && <p>{t.exportUnavailable}</p>}
            {exportProblem === 'reauth' && (
              <a className="btn" href={`/auth/login?reauth=1&returnTo=${encodeURIComponent('/app/privacy?export=1')}`}>
                {t.reauthGo}
              </a>
            )}
          </div>
        )}
        {exportJob?.status === 'ready' ? (
          <>
            <p className="status" data-testid="export-ready">{t.exportReady(fmt.format(new Date(exportJob.expiresAt)))}</p>
            <p>
              <a className="btn" href={`/bff/account/exports/${exportJob.id}/file`} download>
                {t.exportDownload}
              </a>
            </p>
          </>
        ) : exportJob?.status === 'pending' || exportStarting ? (
          <p className="status" aria-live="polite">
            {t.exportPreparing}
          </p>
        ) : (
          exportProblem !== 'reauth' && (
            <p>
              <button type="button" className="btn secondary" onClick={() => void startExport()}>
                {t.exportGo}
              </button>
            </p>
          )
        )}
      </section>

      <SupportAccess lang={lang} csrfToken={csrfToken} fmt={fmt} onAnnounce={setAnnounce} />

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

/** Doc 17: the customer lets one support member see their diagnostic reports by reading out a one-time code. */
function SupportAccess({ lang, csrfToken, fmt, onAnnounce }: { lang: Lang; csrfToken: string; fmt: Intl.DateTimeFormat; onAnnounce: (s: string) => void }) {
  const t = strings(lang);
  const [grants, setGrants] = useState<SupportGrant[] | null>(null);
  const [limits, setLimits] = useState({ codeMinutes: 60, accessDays: 7 });
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const headers = { 'content-type': 'application/json', 'x-csrf-token': csrfToken };

  useEffect(() => {
    fetch('/bff/support-access')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { grants: SupportGrant[]; codeMinutes: number; accessDays: number };
        setGrants(body.grants);
        setLimits({ codeMinutes: body.codeMinutes, accessDays: body.accessDays });
      })
      .catch(() => setGrants([]));
  }, []);

  async function makeCode() {
    setBusy('code');
    setProblem('');
    try {
      const res = await fetch('/bff/support-access/codes', { method: 'POST', headers, body: '{}' });
      if (res.status === 201) setCode((await res.json()) as { code: string; expiresAt: string });
      else setProblem(res.status === 401 ? t.expired : res.status === 429 ? t.rateLimited : t.shareUnavailable);
    } catch {
      setProblem(t.shareUnavailable);
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    setProblem('');
    try {
      const res = await fetch(`/bff/support-access/${id}`, { method: 'DELETE', headers });
      if (res.status === 204 || res.status === 404) {
        setGrants((g) => (g ?? []).filter((x) => x.id !== id));
        onAnnounce(t.shareRevoked);
      } else setProblem(res.status === 401 ? t.expired : res.status === 429 ? t.rateLimited : t.shareUnavailable);
    } catch {
      setProblem(t.shareUnavailable);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="device" aria-labelledby="support-title">
      <h2 id="support-title">{t.shareTitle}</h2>
      <p className="status">{t.shareText(limits.codeMinutes, limits.accessDays)}</p>
      {problem && (
        <div role="alert" className="notice error">
          <p>{problem}</p>
        </div>
      )}
      {code && (
        <p className="support-code" data-testid="support-code">
          <code>{code.code}</code> <span className="status">{t.shareCode(fmt.format(new Date(code.expiresAt)))}</span>
        </p>
      )}
      <p>
        <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => void makeCode()}>
          {busy === 'code' ? t.shareMaking : t.shareGo}
        </button>
      </p>
      {grants !== null && (
        <>
          <h3>{t.shareGrants}</h3>
          {grants.length === 0 ? (
            <p className="status">{t.shareNone}</p>
          ) : (
            <ul className="devices">
              {grants.map((g) => (
                <li key={g.id} data-testid="support-grant">
                  <span className="device-name">{t.shareGrant(fmt.format(new Date(g.grantedAt)), fmt.format(new Date(g.expiresAt)))}</span>
                  <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => void revoke(g.id)}>
                    {t.shareRevoke}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
