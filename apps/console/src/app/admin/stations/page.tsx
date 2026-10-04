import { redirect } from 'next/navigation';
import { filterFrom } from '@/lib/admin';
import { pageLang } from '@/lib/lang';
import { LoadError, staffPage } from './load';
import { StationsView } from './StationsView';

export const dynamic = 'force-dynamic';

export default async function StationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/stations');
  const result = await bff.loadStations(ctx).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/stations');
  if (!('stations' in result) || !result.stations) return <LoadError status={result.status} lang={await pageLang()} />;
  const sp = await searchParams;
  return <StationsView stations={result.stations} filter={filterFrom(sp.status)} query={sp.q?.slice(0, 80) ?? ''} />;
}
