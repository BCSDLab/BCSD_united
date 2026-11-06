import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonc } from './bbot-smoke.mjs';

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (
  manifest.name !== '@koin/b-bot' ||
  manifest.scripts?.build !== 'nitro build' ||
  manifest.scripts.prebuild ||
  manifest.scripts.postbuild
)
  throw new Error('B-BOT build contract changed; trusted verifier needs review');
const mode = process.argv[2] ?? 'build';
if (!['build', 'dry-run'].includes(mode)) throw new Error('Unknown B-BOT build mode');

if (mode === 'build') {
  const require = createRequire(join(root, 'package.json'));
  const nitroManifestPath = require.resolve('nitropack/package.json');
  const nitroManifest = JSON.parse(await readFile(nitroManifestPath, 'utf8'));
  const coreExport = nitroManifest.exports?.['./core']?.import;
  if (typeof coreExport !== 'string' || !coreExport.startsWith('./') || coreExport.split('/').includes('..'))
    throw new Error('Unsupported Nitro core import export');
  const { createNitro, copyPublicAssets, prerender, build } = await import(
    pathToFileURL(resolve(dirname(nitroManifestPath), coreExport)).href
  );
  const nitro = await createNitro({ rootDir: root, dev: false });
  try {
    const output = resolve(root, '.output');
    if (
      resolve(nitro.options.output.dir) !== output ||
      resolve(nitro.options.output.serverDir) !== join(output, 'server') ||
      resolve(nitro.options.output.publicDir) !== join(output, 'public')
    )
      throw new Error('B-BOT output layout changed; trusted verifier needs review');
    const stat = await lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(output)) !== output)
      throw new Error('B-BOT output must be an ordinary sandbox directory');
    for (const asset of nitro.options.publicAssets) {
      const path = await realpath(asset.dir).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return resolve(asset.dir);
      });
      if (path === output || path.startsWith(output + sep))
        throw new Error('Output-contained public assets require explicit verifier support');
    }
    // Nitro prepare() removes .output itself, which is a bind-mount root.
    // Empty its contents instead, preserving the same fresh-output semantics.
    for (const entry of await readdir(output)) await rm(join(output, entry), { recursive: true, force: true });
    if (!nitro.options.noPublicDir) await mkdir(nitro.options.output.publicDir, { recursive: true });
    if (!nitro.options.static) await mkdir(nitro.options.output.serverDir, { recursive: true });
    await copyPublicAssets(nitro);
    await prerender(nitro);
    await build(nitro);
  } finally {
    await nitro.close();
  }
} else {
  const original = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  if (
    original.build?.command !== 'pnpm build' ||
    typeof original.main !== 'string' ||
    typeof original.assets?.directory !== 'string'
  )
    throw new Error('B-BOT deploy build contract changed; trusted verifier needs review');
  const config = {
    ...original,
    main: resolve(root, original.main),
    assets: {
      ...original.assets,
      directory: resolve(root, original.assets.directory),
    },
  };
  delete config.build;
  const directory = join(root, '.wrangler', 'autofix-build');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'wrangler.jsonc');
  await writeFile(path, JSON.stringify(config));
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'deploy', '--dry-run', '--config', path, '--outdir', join(root, 'dist')],
    {
      stdio: 'inherit',
      timeout: 600_000,
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
