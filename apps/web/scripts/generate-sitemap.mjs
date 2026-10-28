import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { loadEnv } from 'vite';
import { DEPARTMENT_CONTACT_CATEGORIES } from '../src/api/departmentContact/entity.ts';

Object.assign(process.env, loadEnv('production', process.cwd(), 'NEXT_PUBLIC_'));
const { default: config } = await import('../sitemap.config.mjs');
const paths = new Set(DEPARTMENT_CONTACT_CATEGORIES.map((category) => `/department/${category}`));
const directory = path.resolve('src/routes');
for (const file of await readdir(directory)) {
  if (!file.endsWith('.tsx')) continue;
  const source = ts.createSourceFile(file, await readFile(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createFileRoute'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const route = node.arguments[0].text.replace(/\/$/, '') || '/';
      if (!route.includes('$') && !route.includes('_')) paths.add(route);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const excluded = config.exclude.map((pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*')}$`));
const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const siteUrl = config.siteUrl.replace(/\/$/, '');
const timestamp = new Date().toISOString();
const urls = [...paths].filter((route) => !excluded.some((pattern) => pattern.test(route))).sort();
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.map((route) => `<url><loc>${escapeXml(siteUrl + route)}</loc><lastmod>${timestamp}</lastmod><changefreq>${config.changefreq}</changefreq><priority>${config.priority}</priority></url>`).join('\n')
  + '\n</urlset>\n';
const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${siteUrl}/sitemap-0.xml</loc></sitemap></sitemapindex>\n`;
const robots = config.robotsTxtOptions.policies.map((policy) => [
  `User-agent: ${policy.userAgent}`, `Allow: ${policy.allow}`,
  ...policy.disallow.map((route) => `Disallow: ${route}`),
].join('\n')).join('\n\n') + `\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
for (const target of ['public', 'dist/client']) {
  await mkdir(target, { recursive: true });
  await Promise.all([
    writeFile(path.join(target, 'sitemap.xml'), index),
    writeFile(path.join(target, 'sitemap-0.xml'), sitemap),
    writeFile(path.join(target, 'robots.txt'), robots),
  ]);
}
process.stdout.write(`Generated sitemap for ${urls.length} public routes.\n`);
