const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      '@solana-program/memo': path.resolve(__dirname, 'lib/stubs/solana-program-memo.js'),
    };
    return config;
  },
};

module.exports = nextConfig;
