/**
 * Caller-side check for MemoryPackOptions.changedSourceIds: is a cited quote still at its locator? Formatting and comment
 * edits do not change what a line says, so both sides are compared after normalizing them:
 * - whitespace next to punctuation is dropped and other runs become one space;
 * - trailing comments are dropped (`//`, `#` and `--` after whitespace or at line start, and inline block comments),
 *   unless the quote is only a comment, in which case the comment is what the fact cites and is compared as written.
 * Pure and deterministic. A heuristic: a value moved into a comment, or text after `#` in an unquoted shell word, can
 * still read as unchanged.
 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// `--` counts as a comment marker only before a space and a non-dash, so CLI flags such as `-- --watch` stay code.
const LINE_COMMENT = /(^|\s)(?:\/\/|#|--(?=\s+[^\s-]))(?![!{[]).*$/gm;
function spacing(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/ ?([^\p{L}\p{N}_ ]) ?/gu, '$1').trim();
}
function code(text: string): string { return spacing(text.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, '$1')); }
export function memorySourceQuotePresent(quote: string, current: string): boolean {
  const cited = code(quote);
  return cited ? code(current).includes(cited) : spacing(current).includes(spacing(quote));
}
