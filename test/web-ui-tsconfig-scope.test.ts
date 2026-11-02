/**
 * src/web-ui/routes/verse must be included in the web tsconfig so that
 * Vite's bundler and tsc both see the route files.
 *
 * This test reads `src/web-ui/tsconfig.json` at runtime and fails
 * the build if its `include` array would not match any file inside
 * `src/web-ui/routes/verse`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT   = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB    = join(ROOT, 'src', 'web-ui');
const TSCONFIG = join(WEB, 'tsconfig.json');
const VERSE  = join(WEB, 'routes', 'verse');

// Pattern examples used by the web tsconfig (for documentation only).
const EXAMPLE_WILDCARD_GLOB = './' + '**' + '/*.ts';
const EXAMPLE_PREFIXED_GLOB = './src/x' + '/**/y/*.ts';

function hasFilesUnder(d: string): boolean {
  const children = readdirSync(d, { withFileTypes: true });
  return children.some(
    (e) => e.isFile() && /\.tsx?$/.test(e.name),
  );
}

describe('web-ui tsconfig includes routes/verse', () => {
  it('tsconfig.json "include" covers src/web-ui/routes/verse files', () => {
    if (!existsSync(TSCONFIG)) {
      throw new Error(`${TSCONFIG} not found`);
    }

    const raw = JSON.parse(readFileSync(TSCONFIG, 'utf8'));
    const includes: string[] = (raw as Record<string, unknown>).include as string[] | undefined ?? [];

    expect(includes.length).toBeGreaterThan(
      0,
      'src/web-ui/tsconfig.json "include" is missing',
    );

    if (!hasFilesUnder(VERSE)) {
      return; // nothing to cover here — test passes
    }

    // Each include glob must be relative to the tsconfig directory (WEB).
    // A glob like `"./**" matches every file under WEB, including
    // WEB/routes/verse/*, so we verify that at least one include glob
    // would match a file we actually found under the verse directory.
    const anyMatch = includes.some((glob) => {
      const matcher = createPathMatcher(glob, WEB);
      return matcher(VERSE);
    });

    expect(anyMatch).toBe(
      true,
      'src/web-ui/routes/verse is not matched by any tsconfig include pattern: ' + includes.join(', ') + '. The test suite under routes/verse (Composer, Transcript, Workspace, Fleet …) would be excluded from the web build.',
    );
  }, 3_000);
});

/** Build a simple glob matcher for recursion wildcards.

Supported forms (those used by the web tsconfig):
  - `${EXAMPLE_WILDCARD_GLOB}`  (recursion from project root)
  - `${EXAMPLE_PREFIXED_GLOB}`  (recursion from a subdirectory)
  - `"./src/foo"`  (literal directory — not used here)

A match succeeds when the target directory is under (or equal to) the
base that the glob starts from.
*/
function createPathMatcher(
  glob: string,
  tsconfigDir: string,
): (candidateDir: string) => boolean {
  const stem = glob.startsWith('./') ? glob.slice(2) : glob;

  // Root-level recursion (matches every file at every depth
  // from tsconfigDir).  Examples:  "${EXAMPLE_WILDCARD_GLOB}",  "**/*.tsx"
  if (/^[\u002A][\u002A]/.test(stem)) {
    return () => true;
  }

  // Prefixed recursion:  "prefix/**[…]"
  const recMatch = stem.match(new RegExp('^(.*)/[\u002A][\u002A]'));
  if (recMatch) {
    const base = relative(tsconfigDir, join(tsconfigDir, recMatch[1]));
    return (dir: string): boolean => {
      const rel = relative(tsconfigDir, dir);
      return (
        rel !== '.'
        && (rel === base || rel.startsWith(`${base}/`))
      );
    };
  }

  // Literal directory like `"./src/foo"`.
  const literal = stem.startsWith('./')
    ? stem.slice(2)
    : stem;

  return (dir: string): boolean => {
    const target = join(tsconfigDir, literal);
    return dir === target || dir.startsWith(`${target}/`);
  };
}
