import type { Lang } from '@/lib/i18n';
import { DeletionStatus } from './DeletionStatus';

export const dynamic = 'force-dynamic';

/** Public: after deletion the account cannot sign in, so progress is read with the ticket in the URL fragment. */
export default async function AccountDeletedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang: Lang = (await searchParams).lang === 'en' ? 'en' : 'th';
  return <DeletionStatus lang={lang} />;
}
