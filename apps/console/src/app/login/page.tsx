import { safeReturnTo } from '@/lib/cookies';
import { strings } from '@/lib/i18n';
import { pageLang } from '@/lib/lang';
import { LangSwitch } from '../LangSwitch';

export const dynamic = 'force-dynamic';

const MESSAGES = { expired: 'loginExpired', signedOut: 'loginSignedOut', signin: 'loginError', unavailable: 'loginUnavailable' } as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const lang = await pageLang();
  const t = strings(lang);
  const key = params.expired ? 'expired' : params.signedOut ? 'signedOut' : params.error === 'unavailable' ? 'unavailable' : params.error ? 'signin' : null;
  const returnTo = params.returnTo && safeReturnTo(params.returnTo) === params.returnTo ? `?returnTo=${encodeURIComponent(params.returnTo)}` : '';
  return (
    <main className="shell" lang={lang}>
      <div className="nav"><span className="brand">{t.appName}</span><LangSwitch lang={lang} path="/login" /></div>
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
      <p className="auth-links">
        {t.loginNoAccount} <a href="/register">{t.registerStart}</a> · <a href="/recover">{t.loginForgot}</a>
      </p>
    </main>
  );
}
