import { redirect } from 'next/navigation';
import { staffPage } from '../stations/load';
import { OverviewView } from './OverviewView';

export const dynamic = 'force-dynamic';

/** Operations overview (Doc 17 /admin/overview). The API checks the role; the numbers are aggregates only. */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/overview');
  const w = (await searchParams).window;
  const window = w === '1h' || w === '7d' ? w : '24h';
  const result = await bff.loadOverview(ctx, window).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/overview');
  return <OverviewView overview={'overview' in result ? result.overview : undefined} status={result.status} window={window} />;
}
