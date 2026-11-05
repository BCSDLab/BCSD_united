import { fileURLToPath } from 'node:url';

import { cloudflare, type WorkerConfig } from '@cloudflare/vite-plugin';
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
      if (!options.ssr && source === 'utils/ssr/apiTarget') {
        return fileURLToPath(new URL('./src/utils/ssr/apiTarget.client.ts', import.meta.url));
      }

      return null;
    },
  };
}

// wrangler.jsonc 설정을 실행 상황에 따라 덮어쓴다
function workerConfigOverride({
  offlineSmoke,
  devServer,
}: {
  offlineSmoke: boolean;
  devServer: boolean;
}): Partial<WorkerConfig> | undefined {
  // 오류 자동화 검증: 함께 빌드한 로컬 API를 `KOIN_API`로 붙여 SSR과 `/api` gateway가 배포된 Java API 대신 로컬 API/D1을 쓰게 한다
  if (offlineSmoke) {
    return { services: [{ binding: 'KOIN_API', service: 'koin-api' }] };
  }

  // 로컬 개발: 운영 API는 localhost Origin을 허용하지 않으므로 Preview처럼 stage API를 쓴다
  if (devServer) {
    return {
      vars: {
        KOIN_ENVIRONMENT: 'preview',
        KOIN_API_ORIGIN: 'https://api.stage.koreatech.in',
        NEXT_PUBLIC_SENTRY_ENVIRONMENT: 'preview',
      },
    };
  }

  // 배포·vite preview: wrangler.jsonc 그대로
  return undefined;
}

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, root, '');
  const branch = env.WORKERS_CI_BRANCH;
  const mainBranch = env.KOIN_MAIN_BRANCH || 'main';
  const previewBranch = env.KOIN_PREVIEW_BRANCH || 'preview';
  if (env.WORKERS_CI === '1' && branch !== mainBranch && branch !== previewBranch) {
    throw new Error('The stable preview deployment only accepts KOIN_MAIN_BRANCH or KOIN_PREVIEW_BRANCH.');
  }
  env.NEXT_PUBLIC_API_PATH = '/api';
  const offlineSmoke = env.AUTOFIX_OFFLINE_SMOKE === '1' && env.WORKERS_CI !== '1';
  const devServer = command === 'serve' && !isPreview;
  env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = branch === mainBranch ? 'production' : 'preview';
  env.NEXT_PUBLIC_SENTRY_RELEASE ||= env.WORKERS_CI_COMMIT_SHA;

  return {
    resolve: { tsconfigPaths: true },
    ssr: { noExternal: ['@koin/telemetry'] },
    define: Object.fromEntries(
      publicEnvironmentKeys.map((key) => [`process.env.${key}`, JSON.stringify(env[key]) ?? 'undefined']),
    ),
    server: { port: 3000 },
    css: { preprocessorOptions: { scss: { loadPaths: [root, fileURLToPath(new URL('./src', import.meta.url))] } } },
    build: { sourcemap: true },
    plugins: [
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        config: workerConfigOverride({ offlineSmoke, devServer }),
        // Only the isolated verifier builds an auxiliary API into this preview.
        // Normal Workers Builds must never bundle a second deployable Worker.
        auxiliaryWorkers: offlineSmoke ? [{ configPath: '../api/.wrangler/autofix-api/wrangler.jsonc' }] : undefined,
      }),
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
        project: env.SENTRY_PROJECT || (branch === mainBranch ? 'koin-united-prod' : 'koin-united-preview'),
        authToken: env.SENTRY_AUTH_TOKEN,
        release: {
          name: env.NEXT_PUBLIC_SENTRY_RELEASE,
        },
        sourcemaps: {
          disable: !env.SENTRY_AUTH_TOKEN,
          filesToDeleteAfterUpload: ['dist/client/**/*.map'],
        },
        telemetry: false,
      }),
    ],
  };
});
