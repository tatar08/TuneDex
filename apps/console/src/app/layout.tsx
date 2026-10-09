import type { Metadata } from 'next';
import { connection } from 'next/server';
import './fonts';
import './globals.css';

export const metadata: Metadata = { title: 'TuneDeck', robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP nonce (src/proxy.ts) is per request, so no page may be prerendered without it.
  await connection();
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
