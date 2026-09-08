/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@nextdoo/contracts', '@nextdoo/core', '@nextdoo/db'],
  serverExternalPackages: ['postgres', '@node-rs/argon2'],
  experimental: {
    // The sandbox preview is proxied through an e2b host, so server actions
    // must accept that origin in addition to localhost.
    serverActions: { allowedOrigins: ['*'] },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default nextConfig;
