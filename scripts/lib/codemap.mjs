/**
 * scripts/lib/codemap.mjs: regenerate the directory inventory blocks in
 * docs/CODEMAP.md.
 *
 * test/codemap-drift.test.ts pins the content between each
 * `<!-- codemap:<name>:start -->` / `<!-- codemap:<name>:end -->` pair to the
 * sorted directory listing, but until now nothing produced that content —
 * adding a source directory meant hand-editing the generated block. This is
 * the generator half of that contract; `scripts/docs-sync.mjs` calls it.
 *
 * The block format is exactly what the drift test compares: one
 * `- \`<dir>/<name>/\`` line per direct subdirectory, sorted by name.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Marker name → directory it inventories. Kept deliberately explicit rather
 * than discovered: a new generated block means adding a row here AND the
 * matching markers in docs/CODEMAP.md, which the drift test then enforces.
 */
export const CODEMAP_SECTIONS = Object.freeze([
  Object.freeze({ name: 'src', dir: 'src' }),
  Object.freeze({ name: 'core', dir: 'src/core' }),
]);

/** The `- \`<dir>/<name>/\`` lines a block must contain, sorted like the drift test expects. */
export function codemapLines(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => `- \`${dir}/${name}/\``);
}

/** Replace one marker pair's interior with `lines`; throws on missing or malformed markers. */
export function renderCodemapBlock(text, name, lines) {
  const start = `<!-- codemap:${name}:start -->`;
  const end = `<!-- codemap:${name}:end -->`;
  if (text.split(start).length !== 2 || text.split(end).length !== 2 || text.indexOf(start) > text.indexOf(end)) {
    throw new Error(`malformed codemap:${name} markers (expected exactly one start before one end)`);
  }
  const head = text.slice(0, text.indexOf(start) + start.length);
  const tail = text.slice(text.indexOf(end));
  return `${head}\n${lines.join('\n')}\n${tail}`;
}

/** Return `text` with every known codemap block regenerated from `root`'s directories. */
export function renderCodemap(text, { root }) {
  let out = text;
  for (const { name, dir } of CODEMAP_SECTIONS) {
    out = renderCodemapBlock(out, name, codemapLines(root, dir));
  }
  return out;
}
