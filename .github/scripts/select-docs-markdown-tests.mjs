#!/usr/bin/env node
/* global process, console */
// Docs-lane Markdown readers. Same match as the historical grep over
// test/*.test.ts: a quoted .md path, or a quoted docs/ path.
// Files that import test/helpers/require-built-dist.js need `npm run build`
// and are printed nowhere: the full suite still runs them after the build.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKDOWN_READER = /\.md['"`]|['"`]docs\//;
// Any static import of the helper, including a side-effect `import '...'`.
const REQUIRES_BUILT_DIST = /(?:from|import)\s+['"][^'"]*require-built-dist\.js['"]/;

export function isMarkdownReadingTest(source) {
  return MARKDOWN_READER.test(source);
}

export function requiresBuiltDist(source) {
  return REQUIRES_BUILT_DIST.test(source);
}

export function selectDocsMarkdownTests(root = process.cwd()) {
  const directory = join(root, 'test');
  const names = readdirSync(directory).filter((name) => name.endsWith('.test.ts')).sort();
  const selected = [];
  const excluded = [];
  for (const name of names) {
    const source = readFileSync(join(directory, name), 'utf8');
    if (!isMarkdownReadingTest(source)) continue;
    const relativePath = `test/${name}`;
    if (requiresBuiltDist(source)) excluded.push(relativePath);
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
