import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

export async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...(await sourceFiles(`${directory}/${entry.name}`)));
    else if (/\.[jt]sx?$/.test(entry.name)) result.push(`${directory}/${entry.name}`);
  }
  return result;
}

export function matchesRoute(pattern, route, app) {
  const normalized = (app === 'web' ? pattern.replace(/\([^/]+\)\//g, '') : pattern).replace(/\/$/, '') || '/';
  const segments = normalized.split('/').map((part) => {
    if (app === 'web' && part.startsWith('$')) return '[^/]+';
    if (app === 'api' && /^:[A-Za-z0-9_]+$/.test(part)) return '[^/]+';
    if (app === 'api' && /^:[A-Za-z0-9_]+\{\[0-9\]\+\}$/.test(part)) return '[0-9]+';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${segments.join('/')}/?$`).test(route);
}

export function applicationGraph(app) {
  if (!['web', 'api'].includes(app)) throw new Error('Unknown application graph');
  const root = `/work/apps/${app}`;
  const require = createRequire('/work/package.json');
  const ts = require('typescript');
  const config = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  if (config.error) throw new Error('Application TypeScript configuration unavailable');
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  async function dependencies(roots) {
    const visited = new Set();
    async function visit(file) {
      const absolute = resolve(file);
      if (visited.has(absolute) || !absolute.startsWith(`${root}/src/`)) return;
      visited.add(absolute);
      const source = await readFile(absolute, 'utf8');
      for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
        const dependency = ts.resolveModuleName(imported.fileName, absolute, options, ts.sys).resolvedModule
          ?.resolvedFileName;
        if (dependency) await visit(dependency);
        else if (/\.(?:scss|css)$/.test(imported.fileName)) {
          const stylesheet = resolve(
            imported.fileName.startsWith('.') ? dirname(absolute) : `${root}/src`,
            imported.fileName,
          );
          if (ts.sys.fileExists(stylesheet)) await visit(stylesheet);
        }
      }
    }
    for (const file of roots) await visit(file);
    return visited;
  }
  return { root, ts, dependencies };
}
