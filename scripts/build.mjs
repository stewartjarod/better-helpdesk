import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });

const library = {
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  outbase: 'src',
  outdir: 'dist',
  packages: 'external',
  splitting: true,
  target: 'es2022',
  logLevel: 'warning',
};

await build({
  ...library,
  platform: 'node',
  // import.ts is for bin/import.mjs only and stays out of the exports map.
  entryPoints: [
    'src/index.ts',
    'src/adapters.ts',
    'src/testing.ts',
    'src/relays/wraps.ts',
    'src/ui/rich.tsx',
    'src/import.ts',
  ],
  chunkNames: 'chunks/server-[hash]',
});

// Entries keep their 'use client'; the ones esbuild drops sit inside the client boundary.
await build({
  ...library,
  platform: 'browser',
  entryPoints: ['src/widget/index.ts', 'src/admin/index.tsx'],
  chunkNames: 'chunks/client-[hash]',
  logOverride: { 'module-level-directive': 'silent' },
});

await build({
  absWorkingDir: root,
  entryPoints: ['src/widget/standalone.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'dist/widget.js',
  logLevel: 'warning',
});

execFileSync('tsc', ['-p', 'tsconfig.build.json', '--outDir', 'dist'], {
  cwd: root,
  stdio: 'inherit',
});
await addDeclarationExtensions(dist);

// tsc keeps the source's extensionless specifiers, which NodeNext consumers cannot resolve.
async function addDeclarationExtensions(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await addDeclarationExtensions(path);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const source = await readFile(path, 'utf8');
    const fixed = source.replace(
      /(from\s+|import\()(['"])(\.{1,2}\/[^'"]+)\2/g,
      (match, lead, quote, specifier) => {
        if (/\.(js|json)$/.test(specifier)) return match;
        const target = resolve(dirname(path), specifier);
        const file = existsSync(`${target}.d.ts`)
          ? `${specifier}.js`
          : `${specifier}/index.js`;
        return `${lead}${quote}${file}${quote}`;
      }
    );
    if (fixed !== source) await writeFile(path, fixed);
  }
}
