import { redirect } from 'next/navigation';
import { staffPage } from '../stations/load';
import { SettingsView } from './SettingsView';

export const dynamic = 'force-dynamic';

/** System settings: TuneDeck's logo for community stations without one, and the web app's layout theme (admins). The API checks roles. */
export default async function SettingsPage() {
  const { bff, ctx } = await staffPage('/admin/settings');
  const [brand, webTheme] = await Promise.all([bff.loadBrandLogo(ctx), bff.loadWebThemeAdmin(ctx)]);
  if (brand === undefined || webTheme === undefined) redirect('/login?expired=1&returnTo=/admin/settings');
  return <SettingsView brand={brand} webTheme={webTheme} />;
}
