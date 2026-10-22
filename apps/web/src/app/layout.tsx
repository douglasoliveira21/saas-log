import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import { UiProvider } from '@/components/ui';
import './globals.css';

export const metadata: Metadata = { title: BRAND.name, description: 'ERP SaaS para distribuidoras', manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#0b0f17' }] };

// Aplica o tema salvo (ou o do sistema) antes da pintura, evitando o "flash" claro → escuro.
const THEME_SCRIPT = `try{var t=localStorage.getItem('dh-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body><UiProvider>{children}</UiProvider></body>
    </html>
  );
}
