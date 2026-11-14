import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { loadEnv } from 'vite';
import { DEPARTMENT_CONTACT_CATEGORIES } from '../src/api/departmentContact/entity.ts';
import config from '../sitemap.config.mjs';
import { isStageBuild } from './build-target.mjs';

const target = 'dist/client';
await mkdir(target, { recursive: true });
if (isStageBuild(loadEnv('production', process.cwd(), ''))) {
  // stage는 검색 색인에서 뺀다. 크롤러가 noindex를 읽어야 기존 색인이 지워지므로 robots.txt로 크롤링은 막지 않는다.
  // _headers는 Worker를 거치지 않는 정적 자산에, server.ts는 SSR 응답에 같은 헤더를 붙인다.
  await Promise.all([
    writeFile(path.join(target, 'robots.txt'), 'User-agent: *\nAllow: /\n'),
    writeFile(path.join(target, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow\n'),
  ]);
  process.stdout.write('Stage build: skipped sitemap and marked static assets noindex.\n');
  process.exit(0);
}

const paths = new Set(DEPARTMENT_CONTACT_CATEGORIES.map((category) => `/department/${category}`));
const directory = path.resolve('src/routes');
for (const file of await readdir(directory)) {
  if (!file.endsWith('.tsx')) continue;
  const source = ts.createSourceFile(
    file,
    await readFile(path.join(directory, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createFileRoute' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const route = node.arguments[0].text.replace(/\/$/, '') || '/';
      if (!route.includes('$') && !route.includes('_')) paths.add(route);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const excluded = config.exclude.map(
  (pattern) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
        .join('.*')}$`,
    ),
);
const escapeXml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const siteUrl = config.siteUrl.replace(/\/$/, '');
const timestamp = new Date().toISOString();
const urls = [...paths].filter((route) => !excluded.some((pattern) => pattern.test(route))).sort();
const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls
    .map(
      (route) =>
        `<url><loc>${escapeXml(siteUrl + route)}</loc><lastmod>${timestamp}</lastmod><changefreq>${config.changefreq}</changefreq><priority>${config.priority}</priority></url>`,
    )
    .join('\n') +
  '\n</urlset>\n';
const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${siteUrl}/sitemap-0.xml</loc></sitemap></sitemapindex>\n`;
const robots =
  config.robotsTxtOptions.policies
    .map((policy) =>
      [
        `User-agent: ${policy.userAgent}`,
        `Allow: ${policy.allow}`,
        ...policy.disallow.map((route) => `Disallow: ${route}`),
      ].join('\n'),
    )
    .join('\n\n') + `\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
await Promise.all([
  writeFile(path.join(target, 'sitemap.xml'), index),
  writeFile(path.join(target, 'sitemap-0.xml'), sitemap),
  writeFile(path.join(target, 'robots.txt'), robots),
]);
process.stdout.write(`Generated sitemap for ${urls.length} public routes.\n`);
