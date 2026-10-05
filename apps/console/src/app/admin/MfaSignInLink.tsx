'use client';

import { usePathname, useSearchParams } from 'next/navigation';

/** The layout's MFA sign-in link: comes back to the staff page that was open, not a fixed one. */
export function MfaSignInLink({ label }: { label: string }) {
  const pathname = usePathname() || '/admin';
  const query = useSearchParams()?.toString();
  const back = query ? `${pathname}?${query}` : pathname;
  return <a href={`/auth/login?mfa=1&returnTo=${encodeURIComponent(back)}`}>{label}</a>;
}
