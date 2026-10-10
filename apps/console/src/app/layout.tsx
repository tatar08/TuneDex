import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import './fonts';
import './globals.css';

export const metadata: Metadata = { title: 'TuneDeck', robots: { index: false, follow: false } };
// viewport-fit=cover lets pages use the iPhone's safe-area insets (notch, home bar) instead of a letterbox.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP nonce (src/proxy.ts) is per request, so no page may be prerendered without it.
  await connection();
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
