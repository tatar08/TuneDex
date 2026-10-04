'use client';

import { usePathname } from 'next/navigation';

/** Message shown when the API answers MFA_REQUIRED (publish, rollback, audit export). */
export const MFA_NEEDED = 'ขั้นตอนนี้ต้องยืนยันตัวตนด้วย MFA ภายใน 5 นาทีที่ผ่านมา ยังไม่ได้ทำรายการ';

export const isMfaRequired = (status: number, body: { code?: unknown } | null | undefined) => status === 401 && body?.code === 'MFA_REQUIRED';

/** Link that signs in again with MFA and comes back to this page; the action then has to be done again. */
export function MfaLink() {
  const path = usePathname() || '/admin';
  return (
    <a className="adm-link" href={`/auth/login?mfa=1&returnTo=${encodeURIComponent(path)}`}>
      ยืนยัน MFA แล้วกลับมาหน้านี้
    </a>
  );
}
