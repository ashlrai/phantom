/**
 * test-file-collection.test.ts — every test-looking file must be collected by
 * a runner. The backend vitest projects collect every `test/` suite ending in
 * `.test.ts` (unit, real-io and serial-cpu lanes), the web project collects
 * `src/web-ui/` suites ending `.test.ts` or `.test.tsx`, and
 * vitest.config.engineering-performance.ts runs
 * benchmarks/resource-engineering-responsiveness.test.ts. A colocated src
 * suite registers through a one-line test/ wrapper that imports its
 * *.test.js specifier, and a node:test .mjs suite runs through a spawnSync
 * wrapper inside a collected suite (test/deletion-sweep.test.mjs and the
 * scripts/ + tests/ suites in test/node-test-suites.test.ts are the
 * precedents). test/contracts/ is the documented opt-in contract lane
 * (test/contracts/README.md). A file that looks like a test but no runner
 * collects is dead coverage — this guard fails on it, and on test-pattern
 * filenames no glob can match (e.g. a stray `.test.ts-E`). Detached
 * toolchains with their own runners (contrib/, examples/, desktop/,
 * .github/tests/) stay out of scope.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_ROOT = join(ROOT, 'src') + sep;
const WALK_DIRS = ['test', 'src', 'benchmarks', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__snapshots__']);
const TESTISH = /\.(test|spec)\./;
const RUNNABLE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const OPT_IN_PREFIXES = ['test/contracts/'];
const WEB_TEST = /^src\/web-ui\/.*\.test\.[jt]sx?$/;
const BENCH_TEST = 'benchmarks/resource-engineering-responsiveness.test.ts';

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && !entry.name.endsWith('.snap')) {
      yield join(dir, entry.name);
    }
  }
}

const toPosix = (path: string): string => path.split(sep).join('/');

interface Candidate { abs: string; rel: string; base: string }

const candidates: Candidate[] = WALK_DIRS.flatMap((dir) => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return [...walk(abs)]
    .map((file) => ({ abs: file, rel: toPosix(relative(ROOT, file)), base: basename(file) }))
    .filter((c) => TESTISH.test(c.base));
});

/** Files a vitest project collects directly, without a wrapper or spawn. */
const vitestEntry = (c: Candidate): boolean =>
  (c.rel.startsWith('test/') && c.base.endsWith('.test.ts')) ||
  WEB_TEST.test(c.rel) ||
  c.rel === BENCH_TEST;

// Colocated src suites are registered by test/ wrappers whose only import is
// the suite's *.test.js specifier; node:test .mjs suites are spawned by a
// collected suite through a repo-relative '....test.[cm]?js' literal.
// Only backend test files are scanned: wrappers and spawn sites live there.
const IMPORT_RE = /import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const SPAWN_RE = /['"]((?:test|src|benchmarks|scripts|tests)\/[^'"]+\.test\.[cm]?js)['"]/g;
const wrapped = new Set<string>();
const spawned = new Set<string>();
for (const entry of candidates.filter((c) => c.rel.startsWith('test/') && c.base.endsWith('.test.ts'))) {
  const text = readFileSync(entry.abs, 'utf8');
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1]!;
    if (!spec.startsWith('.')) continue;
    const resolved = resolve(dirname(entry.abs), spec);
    for (const cand of [resolved, resolved.replace(/\.js$/, '.ts'), resolved.replace(/\.js$/, '.tsx')]) {
      if (cand.startsWith(SRC_ROOT) && RUNNABLE.test(basename(cand)) && existsSync(cand)) {
        wrapped.add(toPosix(relative(ROOT, cand)));
        break;
      }
    }
  }
  for (const match of text.matchAll(SPAWN_RE)) spawned.add(match[1]!);
}

const collected = (c: Candidate): boolean =>
  vitestEntry(c) || wrapped.has(c.rel) || spawned.has(c.rel) ||
  OPT_IN_PREFIXES.some((prefix) => c.rel.startsWith(prefix));

describe('test file collection', () => {
  it('has no test-pattern filename no runner glob can match', () => {
    const malformed = candidates.filter((c) => !RUNNABLE.test(c.base)).map((c) => c.rel);
    expect(malformed).toEqual([]);
  });

  it('collects every runnable test file', () => {
    const uncollected = candidates
      .filter((c) => RUNNABLE.test(c.base) && !collected(c))
      .map((c) => c.rel);
    expect(uncollected).toEqual([]);
  });
});
