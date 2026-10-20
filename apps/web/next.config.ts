import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

const config: NextConfig = {
  // O navegador fala só com a origem do web; o proxy encaminha /api ao backend (cookies same-origin).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
};

export default config;
