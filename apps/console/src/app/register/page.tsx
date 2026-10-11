import { ExplorerAuthTheme } from '../ExplorerAuthTheme';
import { strings } from '@/lib/i18n';
import { pageLang } from '@/lib/lang';
import { LangSwitch } from '../LangSwitch';

export const dynamic = 'force-dynamic';

/** Doc 17 /register: the provider owns the form, the password and the email verification. */
export default async function RegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const lang = await pageLang();
  const t = strings(lang);
  return (
    <ExplorerAuthTheme><main className="shell auth" lang={lang}>
      <div className="nav"><span className="brand">{t.appName}</span><LangSwitch lang={lang} path="/register" /></div>
      <h1>{t.registerTitle}</h1>
      <p className="lede">{t.registerLede}</p>
      {params.error && <div className="notice error" role="status">{t.registerError}</div>}
      <a className="btn" href="/auth/login?register=1">
        {t.registerStart}
      </a>
      <p className="auth-links"><a href="/login">{t.backToSignIn}</a></p>
    </main></ExplorerAuthTheme>
  );
}
