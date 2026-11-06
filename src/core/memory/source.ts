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

/**
 * Evidence inside the snapshot that a cited quote is no longer current, so facts written under different keys still
 * connect through their sources. `older` is retired when `newer` was observed later and
 * - `same-line`: cites the same `file:` locator with a quote of the same statement (same leading word) that differs once
 *   formatting and comments are ignored;
 * - `diff`: cites a `commit:` whose diff removes a line found in `older`'s quote and does not add it back; or
 * - `message`: cites a `commit:` with no diff whose message names a qualified identifier from `older`'s quote
 *   (`JOB_TIMEOUT_SECONDS`, `tidepool:jobs:dead`), or `file-message`: names the file the older quote came from. The
 *   caller must also check that the facts share a topic (`message`) or that the message names the older fact's topic
 *   (`file-message`).
 * Chat remarks and an agent's own reasoning never retire a cited quote: only file and commit evidence counts.
 */
export interface MemoryEvidenceRef { locator: string; quote: string; observedAt: string }
export type MemoryQuoteRetirement = 'same-line' | 'diff' | 'message' | 'file-message' | null;
const QUALIFIED_IDENTIFIER = /[A-Za-z][A-Za-z0-9]*(?:[_:.-][A-Za-z0-9]+)+/g;
export function memoryQuoteRetiredBy(older: MemoryEvidenceRef, newer: MemoryEvidenceRef): MemoryQuoteRetirement {
  if (newer.observedAt <= older.observedAt || !/^file:/i.test(older.locator)) return null;
  if (/^file:/i.test(newer.locator)) {
    // Two quotes from one line can cite different parts of it (a value and its comment): only the same statement, by its
    // leading word, with a different rest counts as a replacement.
    const lead = (quote: string): string => /^[^\p{L}\p{N}_]*([\p{L}\p{N}_]+)/u.exec(code(quote))?.[1] ?? '';
    return newer.locator === older.locator && lead(older.quote) !== '' && lead(older.quote) === lead(newer.quote)
      && !memorySourceQuotePresent(older.quote, newer.quote) && !memorySourceQuotePresent(newer.quote, older.quote) ? 'same-line' : null;
  }
  if (!/^commit:/i.test(newer.locator)) return null;
  const lines = newer.quote.split('\n');
  const diff = lines.filter(line => /^[-+](?![-+]{2})/.test(line));
  if (diff.length) {
    const added = diff.filter(line => line.startsWith('+')).map(line => code(line.slice(1)));
    return diff.some(line => {
      if (!line.startsWith('-')) return false;
      const removed = code(line.slice(1));
      return removed.length >= 6 && !added.includes(removed) && code(older.quote).includes(removed);
    }) ? 'diff' : null;
  }
  const named = new Set(newer.quote.match(QUALIFIED_IDENTIFIER) ?? []);
  if ((older.quote.match(QUALIFIED_IDENTIFIER) ?? []).some(token => token.length >= 6 && named.has(token))) return 'message';
  // `Dockerfile: move uvicorn to port 8080` names the file the older quote came from.
  const file = /^file:(?:.*\/)?([^/:]{4,})(?::\d+)?$/i.exec(older.locator)?.[1];
  return file && new RegExp(`(?<![\\w.-])${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(newer.quote) ? 'file-message' : null;
}
