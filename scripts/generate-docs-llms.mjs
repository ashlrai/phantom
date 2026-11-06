#!/usr/bin/env node
/**
 * scripts/generate-docs-llms.mjs: keep docs/llms.txt complete and build the
 * agent-readable docs bundle for the site.
 *
 *   node scripts/generate-docs-llms.mjs              # rewrite the generated block in docs/llms.txt
 *   node scripts/generate-docs-llms.mjs --check      # exit 1 if docs/llms.txt is stale
 *   node scripts/generate-docs-llms.mjs --out site   # also write site/docs/<page>.md,
 *                                                    # site/docs/llms.txt and site/docs/llms-full.txt
 *
 * Deterministic and offline. Page discovery lives in scripts/lib/docs-pages.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDocsPages, renderLlmsFull, renderLlmsTxt } from './lib/docs-pages.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsDir = join(root, 'docs');
const llmsPath = join(docsDir, 'llms.txt');

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const outIndex = args.indexOf('--out');
const outArg = outIndex >= 0 ? args[outIndex + 1] : undefined;
if (outIndex >= 0 && !outArg) {
  console.error('usage: generate-docs-llms.mjs [--check] [--out <site-dir>]');
  process.exit(2);
}

const pages = listDocsPages(docsDir);
const current = readFileSync(llmsPath, 'utf8');
const next = renderLlmsTxt(current, pages);

if (check) {
  if (next !== current) {
    console.error('docs/llms.txt is stale: run `node scripts/generate-docs-llms.mjs`');
    process.exit(1);
  }
  console.log(`docs/llms.txt lists all ${pages.length} docs pages`);
  process.exit(0);
}

if (next !== current) write(llmsPath, next);

if (outArg) {
  const outRoot = resolve(root, outArg);
  const rel = relative(root, outRoot);
  if (isAbsolute(rel) || rel.startsWith('..')) {
    console.error('--out must be inside the repository');
    process.exit(2);
  }
  const target = join(outRoot, 'docs');
  for (const page of pages) write(join(target, ...`${page.slug}.md`.split('/')), readFileSync(join(docsDir, ...`${page.slug}.md`.split('/'))));
  write(join(target, 'llms.txt'), next);
  const reference = existsSync(join(docsDir, 'llms-full.txt')) ? readFileSync(join(docsDir, 'llms-full.txt'), 'utf8') : '# Phantom';
  write(join(target, 'llms-full.txt'), renderLlmsFull(docsDir, pages, reference));
  console.log(`wrote ${pages.length} pages under ${relative(root, target) || '.'}`);
}
