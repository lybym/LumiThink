import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ModeHeader } from '../components/navigation/mode-header';

export const metadata: Metadata = {
  title: 'LumiThink MVP',
  description: 'Visual math learning playground for kids and actionable insights for parents.',
};

type RootLayoutProps = {
  children: ReactNode;
};

/**
 * Global shell for all App Router pages.
 * Includes a shared mode-switching header used in both Parent and Kid flows.
 */
export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <ModeHeader />
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </body>
    </html>
  );
}
