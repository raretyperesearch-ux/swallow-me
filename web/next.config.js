/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Phaser doesn't play nice with strict mode
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

module.exports = nextConfig;
