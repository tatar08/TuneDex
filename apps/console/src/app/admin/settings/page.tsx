import { redirect } from 'next/navigation';
import { staffPage } from '../stations/load';
import { SettingsView } from './SettingsView';

export const dynamic = 'force-dynamic';

/** System settings (Tar 2026-10-10): for now, TuneDeck's logo for community stations without one. The API checks roles. */
export default async function SettingsPage() {
  const { bff, ctx } = await staffPage('/admin/settings');
  const brand = await bff.loadBrandLogo(ctx);
  if (brand === undefined) redirect('/login?expired=1&returnTo=/admin/settings');
  return <SettingsView brand={brand} />;
}
