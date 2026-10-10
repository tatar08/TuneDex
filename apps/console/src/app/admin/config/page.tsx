import { redirect } from 'next/navigation';
import { staffPage } from '../stations/load';
import { ConfigView } from './ConfigView';

export const dynamic = 'force-dynamic';

/** App configuration (Doc 17 /admin/config). The API checks the role on every read and change. */
export default async function ConfigPage() {
  const { bff, ctx } = await staffPage('/admin/config');
  const result = await bff.loadConfig(ctx).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/config');
  return <ConfigView view={'view' in result ? result.view : undefined} status={result.status} />;
}
