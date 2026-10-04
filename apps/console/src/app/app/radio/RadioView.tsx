'use client';

import { useEffect, useRef, useState } from 'react';
import type { CatalogStation, Favorite, SyncResult } from '@/lib/bff';
import { Lang, strings } from '@/lib/i18n';
import { AppNav } from '../AppNav';

type Problem = 'conflict' | 'expired' | 'rateLimited' | 'unavailable' | 'gone';

interface Change {
  changeId: string;
  entityId: string;
  type: 'favorite';
  op: 'upsert' | 'delete';
  baseRevision: number;
  value?: { stationId: string; order: number };
}

/** Favorites are edited through the same sync as the phones, so a change from another device shows as a conflict. */
export function RadioView({
  lang,
  csrfToken,
  favorites: initial,
  stations,
}: {
  lang: Lang;
  csrfToken: string;
  /** Null when the list could not be loaded. */
  favorites: Favorite[] | null;
  stations: CatalogStation[] | null;
}) {
  const t = strings(lang);
  const [favorites, setFavorites] = useState<Favorite[]>(initial ?? []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [announce, setAnnounce] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);
  const byId = new Map((stations ?? []).map((s) => [s.id, s]));
  const favoriteOf = new Map(favorites.map((f) => [f.stationId, f]));
  const label = (stationId: string) => byId.get(stationId)?.name ?? t.radioStationGone;

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    if (problem) alertRef.current?.focus();
  }, [problem]);

  async function reload() {
    const res = await fetch('/bff/favorites', { headers: { accept: 'application/json' } }).catch(() => null);
    if (res?.ok) setFavorites(((await res.json()) as { favorites: Favorite[] }).favorites);
  }

  /** Sends the changes; on success applies them locally, otherwise reloads and says why. */
  async function push(changes: Change[], done: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/bff/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ changes }),
      });
      if (res.status === 401) return setProblem('expired');
      if (res.status === 429) return setProblem('rateLimited');
      if (!res.ok) return setProblem('unavailable');
      const { results } = (await res.json()) as { results: SyncResult[] };
      const failed = results.find((r) => r.status !== 'applied');
      if (failed) {
        setProblem(failed.status === 'rejected' && failed.reason === 'unknown_station' ? 'gone' : 'conflict');
        await reload();
        return;
      }
      await reload();
      setAnnounce(done);
    } catch {
      setProblem('unavailable');
    } finally {
      setBusy(false);
    }
  }

  const id = () => crypto.randomUUID();
  const add = (s: CatalogStation) =>
    push(
      [{ changeId: id(), entityId: id(), type: 'favorite', op: 'upsert', baseRevision: 0, value: { stationId: s.id, order: favorites.length ? Math.min(9999, Math.max(...favorites.map((f) => f.order)) + 1) : 0 } }],
      t.radioAdded(s.name),
    );
  const remove = (f: Favorite) => push([{ changeId: id(), entityId: f.entityId, type: 'favorite', op: 'delete', baseRevision: f.revision }], t.radioRemoved(label(f.stationId)));
  /** Moving swaps positions with the neighbour; both changes name the revisions shown, so a stale list conflicts. */
  function move(i: number, by: -1 | 1) {
    const a = favorites[i];
    const b = favorites[i + by];
    // Equal orders (from two devices) would not swap, so positions are used when they collide.
    const [oa, ob] = a.order === b.order ? [i + by, i] : [b.order, a.order];
    void push(
      [
        { changeId: id(), entityId: a.entityId, type: 'favorite', op: 'upsert', baseRevision: a.revision, value: { stationId: a.stationId, order: oa } },
        { changeId: id(), entityId: b.entityId, type: 'favorite', op: 'upsert', baseRevision: b.revision, value: { stationId: b.stationId, order: ob } },
      ],
      t.radioMoved(label(a.stationId)),
    );
  }

  return (
    <main className="shell">
      <AppNav lang={lang} current="/app/radio" csrfToken={csrfToken} />
      <h1>{t.radioTitle}</h1>
      <p className="lede">{t.radioLede}</p>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {problem && (
        <div role="alert" className="notice error" tabIndex={-1} ref={alertRef}>
          {problem === 'conflict' && <p>{t.radioConflict}</p>}
          {problem === 'gone' && <p>{t.radioUnavailable}</p>}
          {problem === 'expired' && (
            <p>
              {t.expired} <a href="/login?returnTo=/app/radio">{t.signIn}</a>
            </p>
          )}
          {problem === 'rateLimited' && <p>{t.rateLimited}</p>}
          {problem === 'unavailable' && <p>{t.unavailable}</p>}
        </div>
      )}

      <section className="device" aria-labelledby="fav-title">
        <h2 id="fav-title">{t.radioFavorites}</h2>
        {initial === null && <p className="status">{t.radioLoadError}</p>}
        {initial !== null && favorites.length === 0 && <p className="status">{t.radioFavoritesNone}</p>}
        {favorites.length > 0 && (
          <ol className="devices radio-list">
            {favorites.map((f, i) => (
              <li key={f.entityId} data-testid="favorite">
                <span className="device-name">{label(f.stationId)}</span>
                <span className="radio-actions">
                  <button type="button" className="btn secondary small" disabled={busy || i === 0} aria-label={t.radioUp(label(f.stationId))} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="btn secondary small" disabled={busy || i === favorites.length - 1} aria-label={t.radioDown(label(f.stationId))} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="btn secondary small" disabled={busy} aria-label={t.radioRemove(label(f.stationId))} onClick={() => remove(f)}>
                    ★
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="device" aria-labelledby="cat-title">
        <h2 id="cat-title">{t.radioCatalog}</h2>
        {stations === null && <p className="status">{t.radioLoadError}</p>}
        {stations !== null && stations.length === 0 && <p className="status">{t.radioCatalogNone}</p>}
        {stations && stations.length > 0 && (
          <ul className="devices radio-list">
            {stations.map((s) => {
              const fav = favoriteOf.get(s.id);
              return (
                <li key={s.id} data-testid="station">
                  <span className="device-name">{s.name}</span>
                  <span className="radio-actions">
                    <button
                      type="button"
                      className="btn secondary small"
                      aria-pressed={!!fav}
                      disabled={busy}
                      aria-label={fav ? t.radioRemove(s.name) : t.radioAdd(s.name)}
                      onClick={() => (fav ? remove(fav) : add(s))}
                    >
                      {fav ? '★' : '☆'}
                    </button>
                  </span>
                  <span className="status">
                    {[s.country, s.language.toUpperCase(), s.genres.join(', '), s.bitrateKbps ? `${s.codec.toUpperCase()} ${s.bitrateKbps} kbps` : s.codec.toUpperCase()].filter(Boolean).join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
