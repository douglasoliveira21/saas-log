import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

// Arquivos estáticos que quase não mudam: o navegador guarda e não pergunta de novo por 1 dia (e revalida em segundo plano por 1 semana).
const STATIC_CACHE = 'public, max-age=86400, stale-while-revalidate=604800';

const config: NextConfig = {
  compress: true, // Gzip/Brotli das páginas e scripts
  poweredByHeader: false,
  experimental: { optimizePackageImports: ['lucide-react'] }, // carrega só os ícones usados
  // O navegador fala só com a origem do web; o proxy encaminha /api ao backend (cookies same-origin).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      { source: '/brand/:path*', headers: [{ key: 'Cache-Control', value: STATIC_CACHE }] },
      { source: '/politicas/:path*', headers: [{ key: 'Cache-Control', value: STATIC_CACHE }] },
      { source: '/marketplaces/:path*', headers: [{ key: 'Cache-Control', value: STATIC_CACHE }] },
    ];
  },
};

export default config;
