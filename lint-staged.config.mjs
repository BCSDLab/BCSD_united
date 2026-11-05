import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const webDirectory = new URL('./apps/web/', import.meta.url);
const webSourceDirectory = fileURLToPath(new URL('src/', webDirectory));
const { ESLint } = createRequire(new URL('package.json', webDirectory))('eslint');
const webLinter = new ESLint({ cwd: fileURLToPath(webDirectory) });
const quoteFiles = (files) => files.map((file) => JSON.stringify(file.replaceAll('\\', '/'))).join(' ');

export default {
  'apps/web/src/**/*.{ts,tsx,js,jsx}': async (files) => {
    const ignored = await Promise.all(files.map((file) => webLinter.isPathIgnored(file)));
    const lintable = files.filter((_file, index) => !ignored[index]);

    return [
      `oxfmt --write ${quoteFiles(files)}`,
      ...(lintable.length
        ? [`corepack pnpm --filter @koin/web exec eslint --fix --max-warnings 0 ${quoteFiles(lintable)}`]
        : []),
    ];
  },
  'apps/web/src/**/*.scss': [
    'oxfmt --write',
    'corepack pnpm --filter @koin/web exec stylelint --fix --config .stylelint.json',
  ],
  '*.{ts,tsx,js,jsx,cjs,cts,mts,json,jsonc,md,yml,yaml,mjs}': (files) => {
    const remaining = files.filter(
      (file) => !(file.startsWith(webSourceDirectory) && /\.(?:ts|tsx|js|jsx)$/.test(file)),
    );
    return remaining.length ? [`oxfmt --write ${quoteFiles(remaining)}`] : [];
  },
};
