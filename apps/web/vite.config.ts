import { fileURLToPath } from 'node:url';

import { cloudflare } from '@cloudflare/vite-plugin';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import svgr from 'vite-plugin-svgr';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicEnvironmentKeys = [
  'NEXT_PUBLIC_API_PATH',
  'NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID',
  'NEXT_PUBLIC_GOOGLE_ANALYTICS_ID',
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_SENTRY_DSN',
  'NEXT_PUBLIC_SENTRY_ENVIRONMENT',
  'NEXT_PUBLIC_SENTRY_RELEASE',
  'NEXT_PUBLIC_ORDER_ENABLED',
];

function browserRequestContext(): Plugin {
  return {
    name: 'koin-browser-request-context',
    enforce: 'pre',
    resolveId(source, _importer, options) {
      if (!options.ssr && source === 'utils/ssr/cookieForwarding') {
        return fileURLToPath(new URL('./src/utils/ssr/cookieForwarding.client.ts', import.meta.url));
      }

      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');

  return {
    resolve: { tsconfigPaths: true },
    define: Object.fromEntries(
      publicEnvironmentKeys.map((key) => [`process.env.${key}`, JSON.stringify(env[key]) ?? 'undefined']),
    ),
    server: { port: 3000 },
    css: { preprocessorOptions: { scss: { loadPaths: [root, fileURLToPath(new URL('./src', import.meta.url))] } } },
    build: { sourcemap: true },
    plugins: [
      cloudflare({ viteEnvironment: { name: 'ssr' } }),
      browserRequestContext(),
      svgr({
        include: '**/*.svg',
        svgrOptions: {
          plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
          svgoConfig: { plugins: [] },
        },
      }),
      tanstackStart(),
      react({ compiler: true }),
      sentryVitePlugin({
        org: env.SENTRY_ORG || 'bcsd',
        project: env.SENTRY_PROJECT || 'koin-prod',
        authToken: env.SENTRY_AUTH_TOKEN,
        release: {
          name: env.NEXT_PUBLIC_SENTRY_RELEASE,
          setCommits: env.SENTRY_AUTH_TOKEN ? { auto: true, ignoreMissing: true } : undefined,
        },
        sourcemaps: {
          disable: !env.SENTRY_AUTH_TOKEN,
          filesToDeleteAfterUpload: ['dist/**/*.map'],
        },
        telemetry: false,
      }),
    ],
  };
});
