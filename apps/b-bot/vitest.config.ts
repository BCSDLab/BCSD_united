import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 유료 AI 호출은 테스트에서 명시적으로 켜며, DB 설정만 import.meta.env로 전달한다.
  envPrefix: ['VITE_', 'DB_'],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      // nitro.config.ts의 alias와 맞춘다.
      '@/constant': fileURLToPath(new URL('./src/constant', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
