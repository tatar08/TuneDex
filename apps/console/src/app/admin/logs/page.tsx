import { redirect } from 'next/navigation';
import { logApiParams, logHref, logSearchFrom } from '@/lib/admin';
import { staffPage } from '../stations/load';
import { LogsView } from './LogsView';

export const dynamic = 'force-dynamic';

/** Staff log search (Doc 17 /admin/logs). The API checks the role and audits every search. */
export default async function LogsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/logs');
  const search = logSearchFrom(await searchParams);
  const result = await bff.loadLogs(ctx, logApiParams(search)).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/logs');
  const page = 'page' in result ? result.page : undefined;
  // Older pages keep the window's end fixed so new lines do not shift them.
  const older = page?.nextCursor ? logHref({ ...search, to: search.to || new Date().toISOString(), cursor: page.nextCursor }) : null;
  return <LogsView page={page} status={result.status} badField={'field' in result ? result.field : undefined} search={search} older={older} />;
}
