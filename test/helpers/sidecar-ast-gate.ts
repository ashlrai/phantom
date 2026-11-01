import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared gate for the sidecar literal-import contract
 * (test/sidecar-literal-imports-315.test.ts).
 *
 * The contract walks ~1700 runtime sources; parsing every file with the
 * TypeScript AST outgrew the 30 s test budget on a loaded runner
 * (RQ-PHX-DAILYCIFIX01 — the Oct 31 run's publication-contract step died on
 * that scan). So files first pass through this linear character scan: it
 * reports whether a source can contain a *non-literal* dynamic import — an
 * `import` keyword followed by trivia, `(`, trivia, and a first argument
 * that is not a simple `'literal'`/`"literal"` immediately closed by `)`.
 * Only those few files need the AST pass.
 *
 * Deliberately conservative — it flags rather than misses:
 *  - comment or newline trivia between `import` and `(` flags.
 *  - `import('x' + y)`, `import('x' as string)` and `import('x', attrs)` flag
 *    because the literal is followed by more argument tokens.
 *  - `import(...)` text inside strings, templates, comments, regex literals
 *    and method/member names flags — the AST pass proves them harmless.
 *  - Type-position `import('mod').T` has a pure literal argument and stays
 *    unflagged; a non-literal argument there would not even compile.
 */
const TRIVIA = /\s/;

function skipTrivia(source: string, i: number): number {
  while (i < source.length) {
    if (source[i] === '/') {
      if (source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) return source.length;
        i = end + 2;
        continue;
      }
      if (source[i + 1] === '/') {
        const end = source.indexOf('\n', i + 2);
        if (end < 0) return source.length;
        i = end + 1;
        continue;
      }
      return i;
    }
    if (TRIVIA.test(source[i]!)) {
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

export function hasComputedImportCandidate(source: string): boolean {
  if (!source.includes('import')) return false;
  const keyword = /\bimport\b/g;
  for (let match = keyword.exec(source); match !== null; match = keyword.exec(source)) {
    let i = skipTrivia(source, match.index + 'import'.length);
    if (source[i] !== '(') continue;
    i = skipTrivia(source, i + 1);
    const c = source[i];
    if (c === undefined || c === ')') return true;
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        const q = source.indexOf(c, j);
        if (q < 0) return true;
        let backslashes = 0;
        for (let k = q - 1; k >= i && source[k] === '\\'; k--) backslashes++;
        if (backslashes % 2 === 1) {
          j = q + 1;
          continue;
        }
        i = skipTrivia(source, q + 1);
        if (source[i] === ')') break;
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

/** Runtime sources the sidecar contract walks (mirrors the test's lister). */
export function runtimeSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...runtimeSourceFiles(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.ts$|\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
