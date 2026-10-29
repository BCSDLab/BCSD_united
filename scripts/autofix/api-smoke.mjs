import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jsonFile } from './common.mjs';
import { API_ORIGIN, delay, readJsonResponse, startLocalApi } from './local-api.mjs';
import { applicationGraph, matchesRoute, sourceFiles } from './source-graph.mjs';

const context = await jsonFile('/input/context.json');
const manifest = await jsonFile('/patch/patch.json');
const route = context.route;
if (
  context.app !== 'api' ||
  context.requestMethod !== 'GET' ||
  typeof route !== 'string' ||
  !/^\/[A-Za-z0-9_/-]*$/.test(route) ||
  route.startsWith('//')
)
  throw new Error('API smoke requires a safe canonical GET route');
const graph = applicationGraph('api');
const roots = [];
for (const file of await sourceFiles(`${graph.root}/src`)) {
  const source = graph.ts.createSourceFile(file, await readFile(file, 'utf8'), graph.ts.ScriptTarget.Latest, true);
  let matched = false;
  function visit(node) {
    if (
      graph.ts.isCallExpression(node) &&
      graph.ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.expression.expression.getText(source) === 'app'
    ) {
      const path = node.arguments[0];
      if (path && graph.ts.isStringLiteralLike(path) && matchesRoute(path.text, route, 'api')) matched = true;
    }
    graph.ts.forEachChild(node, visit);
  }
  visit(source);
  if (matched) roots.push(file);
}
if (!roots.length) throw new Error('Canonical URL has no determinable static API GET handler; manual smoke required');
const dependencies = await graph.dependencies(roots);
dependencies.add(`${graph.root}/src/index.ts`);
const changed = manifest.files.filter((file) => file.path.startsWith('apps/api/src/'));
if (!changed.length || changed.some((file) => !dependencies.has(resolve('/work', file.path))))
  throw new Error('Changed API source is not reachable from the observed endpoint');
const api = await startLocalApi();
try {
  const beforeRequest = api.requestCount(route);
  await readJsonResponse(`${API_ORIGIN}${route}`);
  for (let attempt = 0; attempt < 20 && api.requestCount(route) === beforeRequest; attempt += 1) await delay(100);
  if (api.requestCount(route) === beforeRequest) throw new Error('Local API request evidence is unavailable');
  api.assertHealthy();
  process.stdout.write(`Real local API/D1 smoke passed: GET ${route}\n`);
} finally {
  await api.cleanup();
}
