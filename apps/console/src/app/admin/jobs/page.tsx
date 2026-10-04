import { redirect } from 'next/navigation';
import { staffPage } from '../stations/load';
import { JobsView } from './JobsView';

export const dynamic = 'force-dynamic';

/** Background jobs (Doc 17 /admin/jobs). The API checks the role on every read and retry. */
export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/jobs');
  const s = (await searchParams).status;
  const filter = s === 'failed' || s === 'completed' || s === 'all' ? s : 'open';
  const result = await bff.loadJobs(ctx, filter).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/jobs');
  return <JobsView page={'page' in result ? result.page : undefined} status={result.status} filter={filter} />;
}
