import { redirect } from 'next/navigation';
import { filterFrom } from '@/lib/admin';
import { translator } from '@/lib/admin-i18n';
import type { Lang } from '@/lib/i18n';
import { pageLang } from '@/lib/lang';
import { LoadError, staffPage } from './load';
import { StationsView } from './StationsView';

export const dynamic = 'force-dynamic';

/**
 * Shown when the catalog is longer than the console reads in one go: names past the first pages are found
 * by asking the API to search, not by filtering the list in the browser.
 */
function LongCatalogNote({ count, query, lang }: { count: number; query: string; lang: Lang }) {
  const t = translator(lang);
  return (
    <div className="adm-note" role="status">
      <span>
        {query
          ? t('ผลค้นหา “{0}” จากทั้งแคตตาล็อก {1} สถานี', query, count.toLocaleString('en-US'))
          : t('แคตตาล็อกยาวเกินกว่าจะแสดงทั้งหมด หน้านี้แสดง {0} สถานีแรกตามชื่อ ค้นหาชื่อเพื่อดูสถานีอื่น', count.toLocaleString('en-US'))}
      </span>
      <form method="get" action="/admin/stations">
        <input type="search" name="q" defaultValue={query} maxLength={80} placeholder={t('ค้นหาชื่อสถานี')} aria-label={t('ค้นหาชื่อสถานี')} />
        <button type="submit" className="btn secondary">
          {t('ค้นหา')}
        </button>
      </form>
      {query && (
        <a href="/admin/stations" className="adm-link">
          {t('ล้างการค้นหา')}
        </a>
      )}
    </div>
  );
}

export default async function StationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/stations');
  const result = await bff.loadStations(ctx).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/stations');
  if (!('stations' in result) || !result.stations) return <LoadError status={result.status} lang={await pageLang()} />;
  const sp = await searchParams;
  const query = sp.q?.trim().slice(0, 80) ?? '';
  if (!result.truncated) return <StationsView stations={result.stations} filter={filterFrom(sp.status)} query={query} />;

  // Past the page limit: search on the server so every station can still be reached.
  const lang = await pageLang();
  const found = query ? await bff.loadStations(ctx, { q: query }).catch(() => ({ status: 503 }) as const) : result;
  if (found === null) redirect('/login?expired=1&returnTo=/admin/stations');
  if (!('stations' in found) || !found.stations) return <LoadError status={found.status} lang={lang} />;
  return (
    <>
      <LongCatalogNote count={found.stations.length} query={query} lang={lang} />
      <StationsView stations={found.stations} filter={filterFrom(sp.status)} query={query} />
    </>
  );
}
