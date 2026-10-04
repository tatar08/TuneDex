import { redirect } from 'next/navigation';
import { auditApiParams, auditHref, auditSearchFrom } from '@/lib/admin';
import { staffPage } from '../stations/load';
import { AuditView } from './AuditView';

export const dynamic = 'force-dynamic';

/** Staff audit trail (Doc 17 /admin/audit). The API checks the role and records every read. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/audit');
  const search = auditSearchFrom(await searchParams);
  const result = await bff.loadAudit(ctx, auditApiParams(search)).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/audit');
  const page = 'page' in result ? result.page : undefined;
  const older = page?.nextCursor ? auditHref({ ...search, to: search.to || new Date().toISOString(), cursor: page.nextCursor }) : null;
  return <AuditView page={page} status={result.status} badField={'field' in result ? result.field : undefined} search={search} older={older} />;
}
