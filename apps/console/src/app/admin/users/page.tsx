import { staffPage } from '../stations/load';
import { UsersView } from './UsersView';

export const dynamic = 'force-dynamic';

/** Support lookup (Doc 17 /admin/users). Nothing loads until staff search with a reason; the API checks the role. */
export default async function UsersPage() {
  await staffPage('/admin/users');
  return <UsersView />;
}
