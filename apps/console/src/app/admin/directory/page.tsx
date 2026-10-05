import { redirect } from 'next/navigation';
import { staffPage } from '../stations/load';
import { DirectoryView } from './DirectoryView';

export const dynamic = 'force-dynamic';

/** Worldwide radio (community directory): search as users see it, and the block list. The API checks roles. */
export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/directory');
  const raw = (await searchParams).q;
  const query = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
  const result = await bff.loadDirectory(ctx, query).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/directory');
  return (
    <DirectoryView
      status={result.status}
      blocks={'blocks' in result ? result.blocks : undefined}
      query={query}
      search={'search' in result ? (result.search ?? null) : null}
      searchStatus={'searchStatus' in result ? result.searchStatus : undefined}
    />
  );
}
