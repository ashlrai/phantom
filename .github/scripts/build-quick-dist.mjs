#!/usr/bin/env node
// Quick drift tests need executable dist without repeating the authoritative no-emit typecheck.
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'src');
const excluded = new Set([join(source, 'raycast'), join(source, 'web-ui')]);
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (excluded.has(path)) return [];
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

await build({
  absWorkingDir: root,
  entryPoints: sourceFiles(source),
  outbase: source,
  outdir: join(root, 'dist'),
  bundle: false,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'silent',
});
