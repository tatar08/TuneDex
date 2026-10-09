import { redirect } from 'next/navigation';
import type { DirectoryFilter } from '@/lib/bff';
import { staffPage } from '../stations/load';
import { DirectoryView } from './DirectoryView';

export const dynamic = 'force-dynamic';

/** Worldwide radio (community directory): a country's stations or a name search, each on or off, and the block list. The API checks roles. */
export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { bff, ctx } = await staffPage('/admin/directory');
  const params = await searchParams;
  const text = (k: string) => (typeof params[k] === 'string' ? (params[k] as string).trim() : '');
  const status = text('status');
  const offset = Number(text('offset'));
  const filter: DirectoryFilter = {
    q: text('q').slice(0, 80),
    country: /^[A-Za-z]{2}$/.test(text('country')) ? text('country').toUpperCase() : '',
    status: status === 'active' || status === 'inactive' ? status : 'all',
    offset: Number.isInteger(offset) && offset >= 0 && offset < 5000 ? offset : 0,
  };
  const result = await bff.loadDirectory(ctx, filter).catch(() => ({ status: 503 }) as const);
  if (result === null) redirect('/login?expired=1&returnTo=/admin/directory');
  return (
    <DirectoryView
      status={result.status}
      blocks={'blocks' in result ? result.blocks : undefined}
      filter={filter}
      search={'search' in result ? (result.search ?? null) : null}
      searchStatus={'searchStatus' in result ? result.searchStatus : undefined}
    />
  );
}
