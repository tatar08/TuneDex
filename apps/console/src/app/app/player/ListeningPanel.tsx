'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { strings } from '@/lib/i18n';
import { useDesktop } from '../desktop';
import { PlayerBar, usePlayer } from './Player';
/** Controls only: the provider's video stays in its original layout position. */
export function ListeningPanel({ stage = false }: { stage?: boolean }) {
  const { now, recent, claim, lang } = usePlayer();
  const wide = useDesktop();
  const t = strings(lang);
  useEffect(() => wide ? claim() : undefined, [wide, claim]);
  if (!wide) return null;
  return <aside className={stage ? 'theme-stage' : 'listening-panel'} aria-label={t.listenPanel}>
    <h2>{t.listenPanel}</h2>
    {now ? <><div className="listening-art" aria-hidden="true">{now.name.slice(0, 2).toUpperCase()}</div><PlayerBar /></> : <><p>{t.listenChoose}</p><Link href="/app/home" prefetch={false}>{t.navHome}</Link></>}
    {!stage && <><h3>{t.homeRecent}</h3><ul>{recent.slice(0, 4).map(s => <li key={s.url}><Link href="/app/home" prefetch={false}>{s.name}</Link></li>)}</ul><p className="status">{t.homeRecentMeta}</p></>}
  </aside>;
}
