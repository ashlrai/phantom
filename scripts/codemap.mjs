#!/usr/bin/env node
/**
 * scripts/codemap.mjs - regenerate the directory inventory in docs/CODEMAP.md.
 *
 * The inventory between `<!-- codemap:NAME:start -->` and
 * `<!-- codemap:NAME:end -->` markers is generated: NAME selects which
 * directory it lists, and the block is rewritten with the sorted
 * `- \`<dir>/<name>/\`` lines for every directory actually on disk.
 * test/codemap-drift.test.ts holds the committed file to the same renderer
 * through the shared codemapInventory() helper; `node scripts/docs-sync.mjs`
 * regenerates this surface together with the other generated docs.
 *
 *   node scripts/codemap.mjs           rewrite docs/CODEMAP.md
 *   node scripts/codemap.mjs --check   exit 1 when the inventory is stale
 *
 * Marker names are a closed set (CODEMAP_SECTIONS): an unknown name, a
 * malformed marker or an unbalanced block throws instead of guessing a
 * directory to inventory. No network, credentials or dependencies.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
export const CODEMAP_DOC = 'docs/CODEMAP.md';

/** Marker name -> the repository-relative directory its block inventories. */
export const CODEMAP_SECTIONS = new Map([
  ['src', 'src'],
  ['core', 'src/core'],
]);

/** Sorted `- \`<dir>/<name>/\`` lines for every directory under <dir>. */
export function codemapInventory(root, relDir) {
  return readdirSync(join(root, relDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => `- \`${relDir}/${name}/\``);
}

/** Rewrite every codemap block's body with the current directory inventory. */
export function regenerateCodemap(text, root) {
  const marker = /<!-- codemap:([a-z][a-z0-9-]*):(start|end) -->/g;
  let output = '';
  let cursor = 0;
  let open;
  for (const match of text.matchAll(marker)) {
    const name = match[1];
    const kind = match[2];
    if (!CODEMAP_SECTIONS.has(name)) throw new Error(`Unknown codemap section: ${name}`);
    if (kind === 'start') {
      if (open) throw new Error('Nested codemap block');
      open = { name, end: match.index + match[0].length };
    } else {
      if (!open) throw new Error('Unmatched codemap end');
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      const block = codemapInventory(root, CODEMAP_SECTIONS.get(open.name)).join(newline);
      const inner = text.slice(open.end, match.index);
      // Keep the end marker's own leading indentation.
      const endIndent = (/\n([ \t]*)$/.exec(inner) ?? [null, ''])[1];
      output += `${text.slice(cursor, open.end)}${newline}${block}${newline}${endIndent}${match[0]}`;
      cursor = match.index + match[0].length;
      open = undefined;
    }
  }
  if (open) throw new Error('Unclosed codemap block');
  output += text.slice(cursor);
  // Reject malformed markers rather than silently passing a mistyped block.
  if (/<!--[^>]*?codemap\s*:/.test(text.replace(marker, ''))) throw new Error('Malformed codemap marker');
  return output;
}

export function syncCodemap(root = defaultRoot, { check = false } = {}) {
  const path = resolve(root, CODEMAP_DOC);
  const text = readFileSync(path, 'utf8');
  const generated = regenerateCodemap(text, root);
  if (text === generated) return [];
  if (!check) writeFileSync(path, generated);
  return [CODEMAP_DOC];
}

export function main(args = process.argv.slice(2)) {
  let check = false;
  let root = defaultRoot;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
    else throw new Error('Usage: node scripts/codemap.mjs [--check] [--root directory]');
  }
  const changed = syncCodemap(root, { check });
  for (const file of changed) console.log(`${check ? 'drift' : 'updated'}: ${file}`);
  if (check && changed.length) process.exitCode = 1;
  else console.log(`codemap: ${check ? 'in sync' : 'synchronized'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`codemap: ${error.message}`); process.exitCode = 1; }
}
