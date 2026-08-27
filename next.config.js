/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */

const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');
const path = require('path');

// 检测是否为边缘平台构建
const isCloudflare = process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare';
const isEdgeOne = process.env.EDGEONE_PAGES === '1' || process.env.BUILD_TARGET === 'edgeone';
const isEdgeBuild = isCloudflare || isEdgeOne;

const optimizedPackageImports = [
  '@dnd-kit/core',
  '@dnd-kit/modifiers',
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@heroicons/react',
  'lucide-react',
  'react-icons',
];

const createNextConfig = (phase) => {
  const isDevelopment = phase === PHASE_DEVELOPMENT_SERVER || process.env.NODE_ENV === 'development';

  const nextConfig = {
  // Cloudflare Pages 不支持 standalone，使用默认输出
  output: isEdgeBuild ? undefined : 'standalone',
  eslint: {
    dirs: ['src'],
    // 在生产构建时忽略 ESLint 错误
    ignoreDuringBuilds: true,
  },

  reactStrictMode: false,
  swcMinify: true,

  // OpenNext/esbuild 使用 workerd condition 解析依赖。
  // @libsql/* 等包有 workerd 专用入口（如 web.cjs），Next NFT 默认只追踪 node 入口，
  // 导致 .open-next 里缺少 web.cjs 并报 Could not resolve "@libsql/isomorphic-ws"。
  // 声明为 server external 后，OpenNext 会完整拷贝这些包并应用 workerd 导出。
  // 参见: https://opennext.js.org/cloudflare/howtos/workerd
  serverExternalPackages: [
    '@libsql/client',
    '@libsql/hrana-client',
    '@libsql/isomorphic-ws',
    '@libsql/isomorphic-fetch',
    'libsql',
  ],

  experimental: {
    instrumentationHook: process.env.NODE_ENV === 'production' && !isEdgeBuild,
    optimizePackageImports: optimizedPackageImports,
    webpackBuildWorker: !isEdgeBuild,
    // Next 14.2 仍可能读取此字段；与 serverExternalPackages 保持一致
    serverComponentsExternalPackages: [
      '@libsql/client',
      '@libsql/hrana-client',
      '@libsql/isomorphic-ws',
      '@libsql/isomorphic-fetch',
      'libsql',
    ],
  },

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config, { isServer }) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    // Cloudflare 使用 D1，不需要把 better-sqlite3 原生模块带入 Worker 产物。
    if (isEdgeBuild) {
      config.resolve.alias = {
        ...config.resolve.alias,
        ...Object.fromEntries(
          [
            'better-sqlite3',
            'sharp',
            'nodemailer',
            'socket.io',
            'redis',
            '@vercel/postgres',
            'pg',
            'libsql',
            '@libsql/isomorphic-fetch',
            '@libsql/isomorphic-ws',
          ].map((pkg) => [
            pkg,
            path.resolve(
              __dirname,
              'src/lib/cloudflare-shims/node-unsupported.ts'
            ),
          ])
        ),
        // Cloudflare Workers 有原生 fetch；代理 Agent 在 Workers 中不可用。
        // 用轻量 shim 替换 node-fetch / https-proxy-agent，避免把 Node HTTP 栈打入 Worker。
        'node-fetch': path.resolve(
          __dirname,
          'src/lib/cloudflare-shims/node-fetch.ts'
        ),
        ...(isCloudflare
          ? {
              'https-proxy-agent': path.resolve(
                __dirname,
                'src/lib/cloudflare-shims/https-proxy-agent.ts'
              ),
            }
          : {}),
        // 不要在這個 isEdgeBuild 區塊加 opencc-js identity alias：
        // 此區塊對 client 也生效，會弄壞 TraditionalChineseProvider / title-alias。
        // 若 Worker 體積真的超限，只准加在 isEdgeBuild && isServer。
      };
      config.externals = (config.externals || []).filter((external) => {
        return !(
          external &&
          typeof external === 'object' &&
          Object.prototype.hasOwnProperty.call(external, 'better-sqlite3')
        );
      });
    }

    // Exclude better-sqlite3, D1, Postgres, and Turso modules from client-side bundle
    if (!isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'better-sqlite3': 'commonjs better-sqlite3',
        '@vercel/postgres': 'commonjs @vercel/postgres',
        'pg': 'commonjs pg',
        '@libsql/client': 'commonjs @libsql/client',
      });

      config.resolve.alias = {
        ...config.resolve.alias,
        'better-sqlite3': false,
        '@/lib/d1.db': false,
        '@/lib/d1-adapter': false,
        '@/lib/postgres.db': false,
        '@/lib/postgres-adapter': false,
        '@/lib/turso-adapter': false,
      };
    }

    return config;
  },
};

  // next-pwa runs an additional webpack pass that is not needed for the
  // Cloudflare/OpenNext worker bundle and can make Cloudflare builds fail with
  // a generic "Build failed because of webpack errors" message.
  if (isDevelopment || isEdgeBuild) {
    return nextConfig;
  }

  // next-pwa 的預設 runtimeCaching 會把 API 回應寫進瀏覽器 Cache Storage，
  // 而 Workbox 只看 HTTP 200，完全不理 `Cache-Control: private, no-store`。
  //
  // 這對本站是授權繞過：漫畫 API 與圖片代理的回應是「經過登入與 SourceIds
  // 授權」才產生的，一旦落進 SW 快取，就能在來源被停用、使用者登出、或換人
  // 使用同一個 browser profile 之後，於請求抵達授權檢查前被重播出來。
  //
  // 只移除 `apis` 規則不夠：預設清單裡的副檔名規則（static-image-assets、
  // static-data-assets 等）用 RegExp 比對**完整 URL**且排在 API 規則之前，
  // 所以 `/api/manga/search?q=x.jpg` 仍會被當成靜態圖片快取。
  // Workbox 依註冊順序比對，因此把 same-origin `/api/` 的 NetworkOnly
  // 規則插在最前面，讓它一定先命中。
  const pwaDefaultCaching = require('next-pwa/cache');
  const runtimeCaching = [
    {
      urlPattern: ({ url }) =>
        self.origin === url.origin && url.pathname.startsWith('/api/'),
      handler: 'NetworkOnly',
    },
    ...pwaDefaultCaching.filter(
      (entry) => entry?.options?.cacheName !== 'apis'
    ),
  ];

  const withPWA = require('next-pwa')({
    dest: 'public',
    register: true,
    skipWaiting: true,
    importScripts: ['/push-sw.js'],
    runtimeCaching,
  });

  return withPWA(nextConfig);
};

module.exports = createNextConfig;
