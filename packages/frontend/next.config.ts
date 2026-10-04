import type { NextConfig } from 'next';

/**
 * `reactStrictMode` is enabled deliberately.
 *
 * It was previously turned off, which hides exactly the class of bug this
 * codebase had the most of: effects that registered listeners, timers or
 * peer connections without cleaning them up. Strict Mode double-invokes
 * effects in development precisely to surface that, so turning it off meant
 * shipping the bugs.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  compress: true,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            // The app needs none of these. Locking them down matters because a
            // file-sharing site is an attractive target for embedding.
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
      {
        // The service worker must never be cached, or a stale one survives a
        // deploy and serves old assets indefinitely.
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
      {
        source: '/icons/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },

  async rewrites() {
    // Convenience for the QR flow: a short link that opens the flight page.
    // Kept as a rewrite rather than a redirect so the URL stays canonical.
    return [{ source: '/f/:code', destination: '/flight/:code' }];
  },
};

export default nextConfig;
