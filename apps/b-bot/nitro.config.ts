import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { defineNitroConfig } from 'nitropack/config';

export default defineNitroConfig({
  srcDir: 'src',
  preset: 'cloudflare_module',
  compatibilityDate: '2026-10-28',
  serveStatic: true,
  experimental: { tasks: true },
  alias: {
    '@/constant': fileURLToPath(new URL('./src/constant', import.meta.url)),
    exceljs: fileURLToPath(new URL('./node_modules/exceljs/dist/exceljs.min.js', import.meta.url)),
  },
  cloudflare: { nodeCompat: true, deployConfig: false },
  // 두 번 번들링하면 호출 컨텍스트가 분리되므로 최종 Wrangler 번들에서만 공유 패키지를 묶는다.
  rollupConfig: {
    external: ['@koin/b-bot-ai', '@koin/b-bot-database'],
  },
  // Workers는 `pg`의 JavaScript 드라이버만 사용하므로 선택적 libpq 모듈을 번들에서 제외한다.
  commonJS: {
    ignore: ['pg-native'],
    requireReturnsDefault: (id) => (isBuiltin(id) ? 'preferred' : 'auto'),
  },
  storage: {
    kvStorage: { driver: 'cloudflare-kv-binding', binding: 'BOT_KV' },
  },
  scheduledTasks: {
    '* * * * *': 'dining:deliver',
    '*/5 * * * *': 'bus:versionUpdate',
    '0 18 * * *': 'sync:github',
    '30 18 * * 1': 'sync:notion',
    '0 19 * * *': 'sync:gdrive',
  },
});
