import { redirect } from 'next/navigation';
import { filterFrom } from '@/lib/admin';
import { staffPage } from '../load';
import { StationEditor } from '../StationEditor';
import { WorkbenchSplit } from '../StationsView';

export const dynamic = 'force-dynamic';

export default async function NewStationPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { bff, ctx, theme } = await staffPage('/admin/stations/new');
  if (theme !== 'workbench') return <StationEditor />;
  // Workbench keeps the station list beside the editor.
  const list = await bff.loadStations(ctx, { maxPages: 1 }).catch(() => ({ status: 503 }) as const);
  if (list === null) redirect('/login?expired=1&returnTo=/admin/stations/new');
  return (
    <WorkbenchSplit stations={'stations' in list && list.stations ? list.stations : []} filter={filterFrom((await searchParams).status)}>
      <StationEditor />
    </WorkbenchSplit>
  );
}
