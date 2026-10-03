import { strings } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

const MESSAGES = { expired: 'loginExpired', signedOut: 'loginSignedOut', signin: 'loginError', unavailable: 'loginUnavailable' } as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const t = strings('th');
  const key = params.expired ? 'expired' : params.signedOut ? 'signedOut' : params.error === 'unavailable' ? 'unavailable' : params.error ? 'signin' : null;
  const returnTo = params.returnTo?.startsWith('/app/') ? `?returnTo=${encodeURIComponent(params.returnTo)}` : '';
  return (
    <main className="shell">
      <div className="nav"><span className="brand">{t.appName}</span></div>
      <h1>{t.loginTitle}</h1>
      <p className="lede">{t.loginLede}</p>
      {key && (
        <div className={`notice${key === 'signin' || key === 'unavailable' ? ' error' : ''}`} role="status">
          {t[MESSAGES[key]]}
        </div>
      )}
      <a className="btn" href={`/auth/login${returnTo}`} style={{ display: 'inline-block', textDecoration: 'none' }}>
        {t.signIn}
      </a>
    </main>
  );
}
