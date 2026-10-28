export default {
  'apps/web/src/**/*.{ts,tsx,js,jsx}': ['oxfmt --write', 'pnpm --filter @koin/web exec eslint --fix --max-warnings 0'],
  'apps/web/src/**/*.scss': ['oxfmt --write', 'pnpm --filter @koin/web exec stylelint --fix --config .stylelint.json'],
  '*.{json,md,yml,yaml,mjs}': ['oxfmt --write'],
};
