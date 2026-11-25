/**
 * unwired-modules-doc-31: docs/fleet/unwired-modules.md is the inventory of
 * src/core/fleet modules that have no non-test importer. The doc drifted once
 * already (three listed modules were wired and the page kept calling them
 * unwired), so this suite rebuilds the import graph from the working tree and
 * requires the table and the tree to agree in both directions:
 *
 *   - every module the doc lists exists and still has no non-test importer;
 *   - every fleet module with no non-test importer is listed in the doc.
 *
 * "Non-test importer" is any code file outside test/ whose relative import
 * specifier (import/export-from, side-effect or dynamic import) resolves to
 * the module. Test files are test/**, *.test.* / *.spec.* and tests/ dirs.
 * The walk reads the working tree (tracked or not) and prunes dependency and
 * build output directories, so it stays in the fast unit lane: no network,
 * no subprocesses.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const FLEET_PREFIX = 'src/core/fleet/';
const DOC = 'docs/fleet/unwired-modules.md';

const CODE_RE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_RE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Any quoted relative specifier: import/export-from, side-effect and dynamic imports all use one. */
const SPEC_RE = /['"`](\.{1,2}\/[^'"`]*)['"`]/g;
const EXT_RE = /\.(?:[cm]?[jt]sx?)$/;
/** Directories that cannot hold first-party importers of src/core/fleet. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.next', 'build', 'target', '.turbo', '.cache', 'vendor']);

const norm = (p: string): string => posix.normalize(p).replace(EXT_RE, '');
const isTest = (file: string): boolean => TEST_RE.test(file);

interface Graph { files: string[]; importers: Map<string, Set<string>> }

function trackedCodeFiles(): string[] {
  const files: string[] = [];
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile() && CODE_RE.test(entry.name)) {
        files.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return files;
}

/** Module path (extension stripped) -> files whose relative specifiers resolve to it. */
function buildImportGraph(): Graph {
  const files = trackedCodeFiles();
  const importers = new Map<string, Set<string>>();
  const add = (target: string, file: string): void => {
    let set = importers.get(target);
    if (!set) importers.set(target, (set = new Set()));
    set.add(file);
  };
  for (const file of files) {
    let text: string;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    const dir = file.split('/').slice(0, -1).join('/');
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1]!;
      if (spec.includes('${')) continue; // interpolated specifier: not statically resolvable
      const base = norm(posix.join(dir, spec));
      add(base, file);
      add(`${base}/index`, file); // `./dir.js` may resolve to `dir/index.ts`
    }
  }
  return { files, importers };
}

function fleetModules(files: string[]): string[] {
  return files
    .filter((f) => f.startsWith(FLEET_PREFIX) && /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !TEST_RE.test(f))
    .map((f) => f.slice(FLEET_PREFIX.length));
}

function docModules(): string[] {
  const text = readFileSync(join(root, DOC), 'utf8');
  const modules: string[] = [];
  for (const line of text.split('\n')) {
    const cell = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (cell && /\.(?:ts|tsx)$/.test(cell[1]!)) modules.push(cell[1]!);
  }
  return modules;
}

function nonTestImporters(graph: Graph, module: string): string[] {
  const target = norm(posix.join(FLEET_PREFIX.slice(0, -1), module));
  return [...(graph.importers.get(target) ?? [])].filter((f) => !isTest(f)).sort();
}

describe('unwired-modules-doc-31: the doc lists exactly the fleet modules nothing imports', () => {
  const graph = buildImportGraph();
  const modules = fleetModules(graph.files);
  const documented = docModules();
  const unwired = new Set(
    modules.filter((m) => nonTestImporters(graph, m).length === 0),
  );

  it('parses a non-empty module list from the doc table', () => {
    expect(documented.length).toBeGreaterThan(0);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it.each(documented)('docs/fleet/unwired-modules.md row %s exists on disk', (m) => {
    expect(existsSync(join(root, FLEET_PREFIX, m))).toBe(true);
  });

  it.each(documented)('%s still has no non-test importer', (m) => {
    expect(nonTestImporters(graph, m), `${m} is now imported; remove its row from ${DOC}`).toEqual([]);
  });

  it('every fleet module with no non-test importer is listed in the doc', () => {
    const missing = [...unwired].filter((m) => !documented.includes(m)).sort();
    expect(missing, `add these rows to ${DOC}: ${missing.join(', ')}`).toEqual([]);
  });

  it('the doc lists no module that gained a non-test importer', () => {
    const stale = documented.filter((m) => !unwired.has(m)).sort();
    expect(stale, `these rows in ${DOC} are wired now; remove them`).toEqual([]);
  });
});
