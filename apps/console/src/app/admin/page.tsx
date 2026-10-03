import { redirect } from 'next/navigation';
import { canSeeLogs, canSeeStations } from '@/lib/admin';
import { staffPage } from './stations/load';

export const dynamic = 'force-dynamic';

/** Sends each staff member to the first page their roles can open. */
export default async function AdminHome() {
  const { bff, ctx } = await staffPage('/admin');
  const staff = await bff.loadStaff(ctx).catch(() => null);
  const roles = staff && 'roles' in staff ? staff.roles : [];
  redirect(canSeeStations(roles) || !canSeeLogs(roles) ? '/admin/stations' : '/admin/logs');
}
