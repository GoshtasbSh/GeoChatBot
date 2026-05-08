import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'GeoChatBot — Spatial analysis in your browser',
  description:
    'Ask plain-English questions about your spatial data — in your browser. No backend. Files never leave your device. Drop-in or headless.',
  openGraph: {
    title: 'GeoChatBot',
    description:
      'Browser-native spatial agent. DuckDB-WASM + LLM. Zero data server.',
    images: [{ url: '/og-image.svg', width: 1200, height: 630 }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
