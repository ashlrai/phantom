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
import { CODEMAP_SECTIONS as SECTIONS, codemapInventory } from '../codemap.mjs';

export const CODEMAP_SECTIONS = Object.freeze([...SECTIONS].map(([name, dir]) => Object.freeze({ name, dir })));
export const codemapLines = codemapInventory;

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
