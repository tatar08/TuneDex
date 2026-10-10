import { redirect } from 'next/navigation';
import { staffPage } from '../stations/load';
import { SettingsView } from './SettingsView';

export const dynamic = 'force-dynamic';

/** System settings: our own logo for community stations that have none (Tar 2026-10-10). The API checks roles. */
export default async function SettingsPage() {
  const { bff, ctx } = await staffPage('/admin/settings');
  const result = await bff.loadDirectoryLogos(ctx).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/settings');
  return <SettingsView status={result.status} logos={'logos' in result ? result.logos : undefined} />;
}
