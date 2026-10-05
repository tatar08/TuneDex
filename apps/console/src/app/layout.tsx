import type { Metadata } from 'next';
import { jakarta, sarabun } from './admin/fonts';
import './globals.css';

export const metadata: Metadata = { title: 'TuneDeck', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body className={`${jakarta.variable} ${sarabun.variable}`}>{children}</body>
    </html>
  );
}
