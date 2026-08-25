import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'JARVIS - Voice-Controlled Web Agent',
  description: 'Autonomous web browser agent controlled by voice',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
