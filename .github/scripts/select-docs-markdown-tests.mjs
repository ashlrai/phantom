#!/usr/bin/env node
/* global process, console */
// Docs-lane Markdown readers. Same match as the historical grep over
// test/*.test.ts: a quoted .md path, or a quoted docs/ path.
// Files that import test/helpers/require-built-dist.js (directly, via a
// test/helpers module, or with a dynamic import) need `npm run build`
// and are printed nowhere: the full suite still runs them after the build.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKDOWN_READER = /\.md['"`]|['"`]docs\//;
// Module specifiers in static (`from '...'`), side-effect (`import '...'`)
// and dynamic (`import('...')`) imports.
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"`]([^'"`]+)['"`]/g;
const DIST_HELPER = 'require-built-dist';

function importedModules(source) {
  return [...source.matchAll(IMPORT_SPECIFIER)].map(([, specifier]) =>
    (specifier.split('/').pop() ?? '').replace(/\.(?:js|ts|mjs)$/, ''),
  );
}

export function isMarkdownReadingTest(source) {
  return MARKDOWN_READER.test(source);
}

export function requiresBuiltDist(source, distModules = new Set([DIST_HELPER])) {
  return importedModules(source).some((name) => distModules.has(name));
}

// The helper itself plus test/helpers modules that import it (one level).
export function builtDistModules(root = process.cwd()) {
  const modules = new Set([DIST_HELPER]);
  const helpers = join(root, 'test', 'helpers');
  for (const name of readdirSync(helpers).filter((file) => file.endsWith('.ts'))) {
    if (requiresBuiltDist(readFileSync(join(helpers, name), 'utf8'))) {
      modules.add(name.replace(/\.ts$/, ''));
    }
  }
  return modules;
}

export function selectDocsMarkdownTests(root = process.cwd()) {
  const directory = join(root, 'test');
  const names = readdirSync(directory).filter((name) => name.endsWith('.test.ts')).sort();
  const distModules = builtDistModules(root);
  const selected = [];
  const excluded = [];
  for (const name of names) {
    const source = readFileSync(join(directory, name), 'utf8');
    if (!isMarkdownReadingTest(source)) continue;
    const relativePath = `test/${name}`;
    if (requiresBuiltDist(source, distModules)) excluded.push(relativePath);
    else selected.push(relativePath);
  }
  return { selected, excluded };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { selected } = selectDocsMarkdownTests();
  if (selected.length === 0) {
    console.error('no Markdown-reading tests found');
    process.exitCode = 1;
  } else {
    process.stdout.write(`${selected.join('\n')}\n`);
  }
}
