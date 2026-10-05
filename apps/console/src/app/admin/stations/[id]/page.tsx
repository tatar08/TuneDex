import { redirect } from 'next/navigation';
import { filterFrom } from '@/lib/admin';
import { pageLang } from '@/lib/lang';
import { LoadError, staffPage } from '../load';
import { StationEditor } from '../StationEditor';
import { WorkbenchSplit } from '../StationsView';

export const dynamic = 'force-dynamic';

export default async function StationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const returnTo = `/admin/stations/${encodeURIComponent(id)}`;
  const { bff, ctx, theme } = await staffPage(returnTo);
  const [result, health, list] = await Promise.all([
    bff.loadStation(ctx, id).catch(() => ({ status: 503 }) as const),
    bff.loadStationHealth(ctx, id).catch(() => ({ status: 503 }) as const),
    theme === 'workbench' ? bff.loadStations(ctx).catch(() => ({ status: 503 }) as const) : Promise.resolve(undefined),
  ]);
  if (result === null || health === null || list === null) redirect(`/login?expired=1&returnTo=${encodeURIComponent(returnTo)}`);
  const body = 'station' in result && result.station ? <StationEditor key={result.station.id} station={result.station} history={'checks' in health && health.checks ? health.checks : []} /> : <LoadError status={result.status} lang={await pageLang()} />;
  if (theme !== 'workbench') return body;
  return (
    <WorkbenchSplit stations={list && 'stations' in list && list.stations ? list.stations : []} filter={filterFrom((await searchParams).status)} selectedId={id}>
      {body}
    </WorkbenchSplit>
  );
}
