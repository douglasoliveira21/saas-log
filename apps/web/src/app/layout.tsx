import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import './globals.css';

export const metadata: Metadata = { title: BRAND.name, description: 'ERP SaaS para distribuidoras' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
