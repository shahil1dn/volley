import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Builders Live',
  description: 'Live word clouds for AI Builders Society sessions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
