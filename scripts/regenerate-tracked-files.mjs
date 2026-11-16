#!/usr/bin/env node
/**
 * scripts/regenerate-tracked-files.mjs: the one list of tracked generated
 * files. CI's "Check generated files" job runs it and fails on any diff; the
 * Release PR workflow runs it before committing the release candidate, so a
 * stale generated file (docs/llms.txt for v3.30.34) is rewritten inside the
 * release job and can never block a release.
 *
 *   node scripts/regenerate-tracked-files.mjs           # rewrite stale files, print changed paths as JSON
 *   node scripts/regenerate-tracked-files.mjs --check   # exit 1 and list stale files without writing
 *
 * Deterministic and offline. Each generator is a pure render of tracked inputs.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDocsPages, renderLlmsTxt } from './lib/docs-pages.mjs';

/** path (repo-relative, POSIX) -> render(root) returning the expected bytes. */
export const GENERATED_FILES = Object.freeze([
  Object.freeze({
    path: 'docs/llms.txt',
    render: root => renderLlmsTxt(readFileSync(join(root, 'docs', 'llms-source.txt'), 'utf8'), listDocsPages(join(root, 'docs'))),
  }),
]);

/** Returns the repo-relative paths whose bytes differ from their render. Writes only when `write` is true. */
export function regenerateTrackedFiles(root, { write = true, generators = GENERATED_FILES } = {}) {
  const changed = [];
  for (const { path, render } of generators) {
    const target = join(root, ...path.split('/'));
    const next = render(root);
    let current = null;
    try { current = readFileSync(target, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (current === next) continue;
    changed.push(path);
    if (write) writeFileSync(target, next);
  }
  return changed;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) {
    console.error('usage: regenerate-tracked-files.mjs [--check]');
    process.exit(2);
  }
  const check = args.includes('--check');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const changed = regenerateTrackedFiles(root, { write: !check });
  console.log(JSON.stringify({ check, changed }));
  if (check && changed.length) {
    console.error(`generated files are stale: ${changed.join(', ')}; run node scripts/regenerate-tracked-files.mjs`);
    process.exitCode = 1;
  }
}
