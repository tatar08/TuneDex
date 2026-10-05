import { strings } from '@/lib/i18n';
import { pageLang } from '@/lib/lang';
import { LangSwitch } from '../LangSwitch';

export const dynamic = 'force-dynamic';

/** Doc 17 /recover: the provider sends the reset link and never says whether an email has an account. */
export default async function RecoverPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const lang = await pageLang();
  const t = strings(lang);
  return (
    <main className="shell" lang={lang}>
      <div className="nav"><span className="brand">{t.appName}</span><LangSwitch lang={lang} path="/recover" /></div>
      <h1>{t.recoverTitle}</h1>
      {params.expired && <div className="notice error" role="status">{t.recoverExpired}</div>}
      {params.done && <div className="notice" role="status">{t.recoverDone}</div>}
      <p className="lede">{t.recoverLede}</p>
      <a className="btn" href="/auth/recover" style={{ display: 'inline-block', textDecoration: 'none' }}>
        {t.recoverStart}
      </a>
      <p className="auth-links"><a href="/login">{t.backToSignIn}</a></p>
    </main>
  );
}
