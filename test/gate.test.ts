/**
 * scripts/gate.mjs — the pure parts of the fast local release gate: argument parsing,
 * test selection, and how a vitest run becomes PASS / FAIL. Plus the two data
 * files it reads, which must only name test files that exist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_GUARDS,
  GATE_BUILD_ASSET_SCRIPTS,
  MAX_BASENAME_EXTRA_READERS,
  buildCommands,
  checkTypeSpecs,
  corpusGuardTests,
  discoverTextReads,
  evaluateVitest,
  formatDuration,
  isTextReaderTest,
  loadKnownFailures,
  loadSmoke,
  loadTextReads,
  lockfileDependencyChanged,
  packageDependencyChanges,
  parseArgs,
  phaseASpecs,
  planTests,
  renderTable,
} from '../scripts/gate.mjs';

const repoRoot = join(import.meta.dirname, '..');
const smoke = { backend: ['test/smoke-a.test.ts'], web: ['src/web-ui/smoke-b.test.tsx'] };

describe('parseArgs', () => {
  it('defaults to related mode against the default base', () => {
    expect(parseArgs([])).toEqual({ full: false, check: false, base: null, json: false, failFast: false, help: false });
  });

  it('accepts --base in both spellings, --json, --fail-fast, --full', () => {
    expect(parseArgs(['--base', 'v3.11.0', '--json']).base).toBe('v3.11.0');
    expect(parseArgs(['--base=HEAD~3']).base).toBe('HEAD~3');
    expect(parseArgs(['--check']).check).toBe(true);
    expect(() => parseArgs(['--check', '--full'])).toThrow(/cannot be combined/);
    expect(() => parseArgs(['--check', '--fail-fast'])).toThrow(/no effect/);
    expect(parseArgs(['--full', '--fail-fast'])).toMatchObject({ full: true, failFast: true });
  });

  it('rejects unknown flags, a missing ref, and --full with --base', () => {
    expect(() => parseArgs(['--fast'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--base'])).toThrow(/needs a ref/);
    expect(() => parseArgs(['--base', '--json'])).toThrow(/needs a ref/);
    expect(() => parseArgs(['--full', '--base', 'x'])).toThrow(/no effect/);
  });
});

describe('packageDependencyChanges', () => {
  const base = JSON.stringify({ version: '3.11.0', scripts: { a: 'x' }, dependencies: { tar: '1' } });

  it('ignores a version bump or a script edit', () => {
    const next = JSON.stringify({ version: '3.11.1', scripts: { a: 'y', gate: 'z' }, dependencies: { tar: '1' } });
    expect(packageDependencyChanges(base, next)).toEqual([]);
  });

  it('names changed dependency-shaped keys', () => {
    const next = JSON.stringify({ version: '3.11.0', dependencies: { tar: '2' }, overrides: { qs: '1' } });
    expect(packageDependencyChanges(base, next)).toEqual(['dependencies', 'overrides']);
  });

  it('treats an unparseable file as every key changed', () => {
    expect(packageDependencyChanges(base, '{').length).toBeGreaterThan(5);
  });
});

describe('lockfileDependencyChanged', () => {
  const lock = (version: string, tar: string) => JSON.stringify({
    name: '@ashlr/hub', version, lockfileVersion: 3,
    packages: { '': { name: '@ashlr/hub', version }, 'node_modules/tar': { version: tar } },
  });

  it('ignores a release version bump', () => {
    expect(lockfileDependencyChanged(lock('3.11.0', '7.5.22'), lock('3.11.1', '7.5.22'))).toBe(false);
  });

  it('sees a dependency change, a new lockfile, or an unparseable one', () => {
    expect(lockfileDependencyChanged(lock('3.11.0', '7.5.22'), lock('3.11.1', '7.5.23'))).toBe(true);
    expect(lockfileDependencyChanged(null, lock('3.11.1', '7.5.22'))).toBe(true);
    expect(lockfileDependencyChanged(lock('3.11.0', '7.5.22'), '{')).toBe(true);
  });
});

describe('planTests', () => {
  const plan = (changed: string[], dependencyKeys: string[] = [], full = false, lockfileChanged = false) =>
    planTests({ full, changed, dependencyKeys, lockfileChanged, smoke });

  it('runs related tests plus smoke, and drops package.json and the lockfile from the related list', () => {
    const p = plan(['src/core/verse/seats.ts', 'package.json', 'package-lock.json', 'desktop/package.json']);
    expect(p.backend).toEqual({
      mode: 'related',
      reason: '1 changed file(s) + 1 smoke',
      files: ['src/core/verse/seats.ts', 'test/smoke-a.test.ts'],
    });
    expect(p.web.files).toEqual(['src/core/verse/seats.ts', 'src/web-ui/smoke-b.test.tsx']);
  });

  it('runs only the smoke set, without the import graph, when nothing importable changed', () => {
    const expected = { mode: 'smoke', reason: 'no importable change; 1 smoke', files: ['test/smoke-a.test.ts'] };
    expect(plan([]).backend).toEqual(expected);
    expect(plan(['docs/RELEASING-LOCALLY.md', '.gitignore', 'desktop/src-tauri/src/main.rs', 'package.json']).backend)
      .toEqual(expected);
  });

  it('keeps any file that could be a module, including unknown extensions', () => {
    for (const file of ['src/web-ui/x.module.css', 'test/fixtures/a.json', 'src/assets/logo.svg', 'scripts/x.mjs', 'weird.ext']) {
      expect(plan([file]).backend.mode, file).toBe('related');
    }
  });

  it('goes full on a lockfile or dependency change', () => {
    expect(plan(['package-lock.json'], [], false, true).backend)
      .toMatchObject({ mode: 'full', reason: 'package-lock.json dependencies changed' });
    expect(plan(['package.json'], ['devDependencies']).web).toMatchObject({ mode: 'full', reason: 'package.json devDependencies changed' });
  });

  it('goes full per suite on a vitest config or setup file, as vitest itself would', () => {
    const backendSetup = plan(['test/setup/home.ts']);
    expect(backendSetup.backend.mode).toBe('full');
    expect(backendSetup.web.mode).toBe('related');
    const mockCompatSetup = plan(['vitest.config.mock-compat.ts']);
    expect([mockCompatSetup.backend.mode, mockCompatSetup.web.mode]).toEqual(['full', 'full']);
    const webSetup = plan(['src/web-ui/test/setup.ts']);
    expect(webSetup.web.mode).toBe('full');
    expect(webSetup.backend.mode).toBe('related');
    const config = plan(['vitest.config.web.ts']);
    expect([config.backend.mode, config.web.mode]).toEqual(['full', 'full']);
  });

  it('includes mapped text readers for non-module changes in the correct suite', () => {
    const p = planTests({ full: false, changed: ['docs/input.md'], dependencyKeys: [], smoke,
      textReads: { 'docs/input.md': ['test/reader.test.ts', 'src/web-ui/reader.test.tsx'] } });
    expect(p.backend.files).toContain('test/reader.test.ts');
    expect(p.web.files).toContain('src/web-ui/reader.test.tsx');
    expect(p.backend.files).not.toContain('src/web-ui/reader.test.tsx');
    expect(p.backend.mode).toBe('related');
  });

  it('validates the text-read map and rejects missing tests', () => {
    expect(Object.keys(loadTextReads()).length).toBeGreaterThan(0);
    expect(() => loadTextReads({ 'src/a.ts': ['test/missing.test.ts'] })).toThrow(/Invalid text-read mapping/);
  });

  it('--full runs everything', () => {
    expect(plan([], [], true).backend).toEqual({ mode: 'full', reason: 'gate:full', files: [] });
  });
});

describe('corpusGuardTests', () => {
  it('maps doc markdown to the whole-tree link guards', () => {
    expect(corpusGuardTests(['docs/CHANNELS.md'])).toEqual(['test/docs-repo-links.test.ts']);
    expect(corpusGuardTests(['README.md', 'AGENTS.md'])).toEqual(['test/docs-repo-links.test.ts']);
    expect(corpusGuardTests(['docs/fleet/status.md'])).toEqual(['test/docs-fleet-links.test.ts', 'test/docs-repo-links.test.ts']);
  });

  it('maps pane sources, sections, mobile and design trees to their walkers', () => {
    expect(corpusGuardTests(['src/web-ui/routes/verse/apps/Apps.tsx'])).toEqual([
      'src/web-ui/routes/verse/shell/pane-sections.test.ts',
      'test/docs-panes.test.ts',
    ]);
    expect(corpusGuardTests(['src/web-ui/routes/verse/sections/Chat.tsx'])).toEqual([
      'src/web-ui/routes/verse/shell/pane-sections.test.ts',
      'src/web-ui/routes/verse/shell/section-modules.test.ts',
      'test/docs-panes.test.ts',
    ]);
    expect(corpusGuardTests(['src/web-ui/routes/verse/mobile/Mobile.tsx'])).toEqual([
      'src/web-ui/routes/verse/mobile/mobile-overflow.test.ts',
      'src/web-ui/routes/verse/shell/pane-sections.test.ts',
      'test/docs-panes.test.ts',
    ]);
    expect(corpusGuardTests(['src/web-ui/design/tokens.css'])).toEqual([
      'src/web-ui/design/font-ranges.test.ts',
      'src/web-ui/design/subset-glyphs.test.ts',
    ]);
    expect(corpusGuardTests(['docs/PANES.md'])).toEqual(['test/docs-panes.test.ts', 'test/docs-repo-links.test.ts']);
    expect(corpusGuardTests(['schemas/registry.json'])).toEqual(['test/schemas/registry.test.ts']);
  });

  it('ignores scratch paths and files no walker covers', () => {
    expect(corpusGuardTests([
      'BRIDGE_STAGED/note.md', '.github/PULL_REQUEST_TEMPLATE.md', 'workplans/plan.md',
      'contrib/mac/dispatchd.py', 'docs/fleet/notes.txt', 'docs/images/diagram.png',
    ])).toEqual([]);
  });

  it('every guard names an existing vitest test file', () => {
    for (const guard of CORPUS_GUARDS) {
      expect(isTextReaderTest(guard.test), guard.test).toBe(true);
      expect(existsSync(join(repoRoot, guard.test)), guard.test).toBe(true);
    }
  });
});

describe('discoverTextReads', () => {
  const deps = (files: Record<string, string>) => ({
    grep: () => Object.keys(files),
    read: (file: string) => {
      const text = files[file];
      if (text == null) throw new Error(`missing ${file}`);
      return text;
    },
  });

  it('finds tests naming the full repo-relative path', () => {
    const found = discoverTextReads(['docs/CHANNELS.md'], deps({
      'test/docs-a.test.ts': 'reads docs/CHANNELS.md',
      'test/unrelated.test.ts': 'nothing here',
    }));
    expect(found).toEqual({ 'docs/CHANNELS.md': ['test/docs-a.test.ts'] });
  });

  it('adds basename readers when they are few', () => {
    const found = discoverTextReads(['docs/CHANNELS.md'], deps({
      'test/full.test.ts': 'join(ROOT, "docs/CHANNELS.md")',
      'test/joined.test.ts': 'join(dir, "CHANNELS.md")',
    }));
    expect(found['docs/CHANNELS.md']).toEqual(['test/full.test.ts', 'test/joined.test.ts']);
  });

  it('drops the basename when it adds too many readers', () => {
    const files: Record<string, string> = { 'test/full.test.ts': 'docs/CHANNELS.md' };
    for (let i = 0; i < MAX_BASENAME_EXTRA_READERS + 1; i++) files[`test/generic-${i}.test.ts`] = 'CHANNELS.md';
    const found = discoverTextReads(['docs/CHANNELS.md'], deps(files));
    expect(found['docs/CHANNELS.md']).toEqual(['test/full.test.ts']);
  });

  it('ignores candidates that are not vitest test files or cannot be read', () => {
    const found = discoverTextReads(['docs/CHANNELS.md'], {
      grep: () => ['src/core/not-a-test.ts', 'test/fixture.txt', 'test/ok.test.ts', 'test/broken.test.ts'],
      read: (file: string) => {
        if (file === 'test/broken.test.ts') throw new Error('gone');
        return 'docs/CHANNELS.md';
      },
    });
    expect(found).toEqual({ 'docs/CHANNELS.md': ['test/ok.test.ts'] });
  });

  it('returns an empty map for an empty change set without grepping', () => {
    let calls = 0;
    const found = discoverTextReads([], { grep: () => { calls += 1; return []; } });
    expect(found).toEqual({});
    expect(calls).toBe(0);
  });

  it('maps each changed file to its own readers', () => {
    const found = discoverTextReads(['docs/A.md', 'docs/B.md'], deps({
      'test/a.test.ts': 'docs/A.md',
      'test/b.test.ts': 'docs/B.md',
      'test/ab.test.ts': 'docs/A.md docs/B.md',
    }));
    expect(found['docs/A.md']).toEqual(['test/a.test.ts', 'test/ab.test.ts']);
    expect(found['docs/B.md']).toEqual(['test/ab.test.ts', 'test/b.test.ts']);
  });

  it('finds real readers in this repo (guards the grep/read defaults)', () => {
    // docs/ECOSYSTEM-MAP.md is named by doc-facts and ecosystem-index-docs; a
    // silent grep or path regression would return an empty map here.
    const found = discoverTextReads(['docs/ECOSYSTEM-MAP.md']);
    expect(found['docs/ECOSYSTEM-MAP.md']?.length).toBeGreaterThan(0);
  });
});

describe('planTests corpus guards', () => {
  const guarded = (changed: string[], guards: string[]) =>
    planTests({ full: false, changed, dependencyKeys: [], smoke, guards });

  it('runs backend and web guards even when nothing importable changed', () => {
    const p = guarded(['docs/CHANNELS.md'], ['test/docs-repo-links.test.ts', 'src/web-ui/design/font-ranges.test.ts']);
    expect(p.backend).toEqual({
      mode: 'smoke',
      reason: 'no importable change; 1 smoke + 1 guard',
      files: ['test/docs-repo-links.test.ts', 'test/smoke-a.test.ts'],
    });
    expect(p.web).toEqual({
      mode: 'smoke',
      reason: 'no importable change; 1 smoke + 1 guard',
      files: ['src/web-ui/design/font-ranges.test.ts', 'src/web-ui/smoke-b.test.tsx'],
    });
  });

  it('adds guards to related selections too, filtered per suite', () => {
    const p = guarded(['src/core/verse/seats.ts'], ['test/docs-panes.test.ts', 'src/web-ui/x.test.tsx']);
    expect(p.backend.files).toContain('test/docs-panes.test.ts');
    expect(p.backend.files).not.toContain('src/web-ui/x.test.tsx');
    expect(p.backend.reason).toContain('guard');
    expect(p.web.files).toContain('src/web-ui/x.test.tsx');
    expect(p.web.files).not.toContain('test/docs-panes.test.ts');
  });

  it('defaults to no guards', () => {
    const p = planTests({ full: false, changed: ['docs/x.md'], dependencyKeys: [], smoke });
    expect(p.backend.reason).toBe('no importable change; 1 smoke');
  });
});

describe('evaluateVitest', () => {
  const known = new Set(['test/flaky.test.ts']);
  const report = (results: Array<[string, string]>) => ({
    numPassedTests: 9, numFailedTests: 1, numTotalTests: 10, numTotalTestSuites: results.length,
    testResults: results.map(([name, status]) => ({ name: join(repoRoot, name), status })),
  });

  it('passes a clean run', () => {
    const v = evaluateVitest({ exitCode: 0, report: report([['test/a.test.ts', 'passed']]), log: '', known });
    expect(v.status).toBe('pass');
    expect(v.tests).toEqual({ passed: 9, failed: 1, total: 10, files: 1 });
  });

  it('fails a listed file while preserving its diagnostic metadata', () => {
    const v = evaluateVitest({ exitCode: 1, report: report([['test/a.test.ts', 'passed'], ['test/flaky.test.ts', 'failed']]), log: '', known });
    expect(v).toMatchObject({ status: 'fail', knownFiles: ['test/flaky.test.ts'], failedFiles: ['test/flaky.test.ts'] });
    expect(evaluateVitest({ exitCode: 0, report: report([['test/flaky.test.ts', 'failed']]), log: '', known }).status).toBe('fail');
  });

  it('fails on any unlisted failing file, even next to a known one', () => {
    const v = evaluateVitest({ exitCode: 1, report: report([['test/b.test.ts', 'failed'], ['test/flaky.test.ts', 'failed']]), log: '', known });
    expect(v).toMatchObject({ status: 'fail', failedFiles: ['test/b.test.ts', 'test/flaky.test.ts'], knownFiles: ['test/flaky.test.ts'] });
  });

  it('fails on unhandled errors that no file owns', () => {
    const v = evaluateVitest({ exitCode: 1, report: report([['test/flaky.test.ts', 'failed']]), log: '⎯⎯ Unhandled Errors ⎯⎯', known });
    expect(v.status).toBe('fail');
  });

  it('fails when vitest exits non-zero without a failing file, or writes no report', () => {
    expect(evaluateVitest({ exitCode: 1, report: report([['test/a.test.ts', 'passed']]), log: '', known }).status).toBe('fail');
    expect(evaluateVitest({ exitCode: 1, report: null, log: '', known }).status).toBe('fail');
    expect(evaluateVitest({ exitCode: 0, report: null, log: '', known }).status).toBe('fail');
  });
});

describe('output', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(formatDuration(179_600)).toBe('3m00s');
    expect(formatDuration(59_970)).toBe('1m00s');
  });

  it('renders an aligned table', () => {
    const table = renderTable([
      { name: 'build', status: 'pass', durationMs: 1000, detail: null },
      { name: 'tests-backend', status: 'fail', durationMs: 61_000, detail: 'related' },
    ]);
    expect(table.split('\n')).toEqual([
      'step           status  duration  detail',
      '-------------  ------  --------  -------',
      'build          PASS    1.0s',
      'tests-backend  FAIL    1m01s     related',
    ]);
  });
});

describe('gate data files', () => {
  it('the smoke set names existing test files, each with a reason', () => {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'scripts/gate-smoke.json'), 'utf8'));
    for (const entry of [...raw.backend, ...raw.web]) expect(entry.why, entry.file).toBeTruthy();
    const files = loadSmoke();
    // Style readers do not import the CSS they validate, so related selection
    // must retain these explicit smoke contracts alongside the existing shell checks.
    expect([...files.web].sort()).toEqual([
      'src/web-ui/design/control-density.test.ts',
      'src/web-ui/design/micro-label-font.test.ts',
      'src/web-ui/design/style-scan-310.test.ts',
      'src/web-ui/design/tokens-contrast.test.ts',
      'src/web-ui/design/ui-scale.test.ts',
      'src/web-ui/routes/verse/VerseApp.first-paint.test.ts',
      'src/web-ui/routes/verse/VerseApp.test.tsx',
      'src/web-ui/routes/verse/sections/ChatSection.first-paint.test.tsx',
    ]);
    for (const suite of [files.backend, files.web]) expect(new Set(suite).size).toBe(suite.length);
    expect(files.backend.length).toBeGreaterThan(0);
    for (const file of [...files.backend, ...files.web]) expect(existsSync(join(repoRoot, file)), file).toBe(true);
    for (const file of files.backend) expect(file).toMatch(/^test\/.+\.test\.ts$/);
    for (const file of files.web) expect(file).toMatch(/^src\/web-ui\/.+\.test\.tsx?$/);
  });

  it('every known failure is an existing test file with a reason', () => {
    for (const [file, reason] of loadKnownFailures()) {
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
      expect(reason.length, file).toBeGreaterThan(10);
    }
  });

  it('the build step runs tsc, then the asset copy from `npm run build` (dist/core/web/public/ in a fresh worktree)', () => {
    const commands = buildCommands({ nodeBin: 'node', tscBin: 'TSC', tsBuildInfoFile: '.ashlr-gate/tsc.tsbuildinfo' });
    expect(commands[0]).toEqual({ cmd: 'node', args: ['TSC', '-p', 'tsconfig.json', '--incremental', '--tsBuildInfoFile', '.ashlr-gate/tsc.tsbuildinfo'] });
    expect(commands.slice(1).map((c) => c.args)).toEqual(GATE_BUILD_ASSET_SCRIPTS.map((script) => [script]));
    // test/activation-readiness-package.test.ts reads dist/core/web/public/app.js; copy-assets writes it.
    expect(GATE_BUILD_ASSET_SCRIPTS).toContain('scripts/copy-assets.mjs');
    expect(readFileSync(join(repoRoot, 'scripts/copy-assets.mjs'), 'utf8')).toContain("join(repoRoot, 'dist', 'core', 'web', 'public')");
  });

  it('every gate build asset script is still a step of `npm run build` (reused, never forked)', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const buildSteps = String(pkg.scripts.build).split('&&').map((step) => step.trim());
    // Public version consistency precedes compilation; the gate reuses every asset step after tsc.
    expect(buildSteps.slice(0, 2)).toEqual(['npm run check:version', 'tsc -p tsconfig.json']);
    const positions = GATE_BUILD_ASSET_SCRIPTS.map((script) => buildSteps.indexOf(`node ${script}`));
    for (const [i, pos] of positions.entries()) expect(pos, GATE_BUILD_ASSET_SCRIPTS[i]).toBeGreaterThan(1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('phase A typechecks both projects once, inside typecheck-fast — no duplicate web pass', () => {
    const specs = phaseASpecs({ nodeBin: 'node', npmCmd: 'npm', tscBin: 'TSC', eslintBin: 'ESLINT', gateDir: '.ashlr-gate' });
    // Exactly one typecheck step: the npm script that runs tsgo on both projects.
    expect(specs.filter((spec) => spec.name.includes('typecheck')).map((spec) => spec.name)).toEqual(['typecheck-fast']);
    // No step invokes a compiler on the web tsconfig directly.
    for (const spec of specs) expect(spec.args.join(' ')).not.toContain('src/web-ui/tsconfig.json');
    // And typecheck:fast itself still names the web project, matching `npm run typecheck`.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['typecheck:fast']).toContain('tsgo');
    expect(pkg.scripts['typecheck:fast']).toContain('src/web-ui/tsconfig.json');
  });

  it('scopes the test-names step to the merge-base, keeping the strict scan without one', () => {
    const opts = { nodeBin: 'node', npmCmd: 'npm', tscBin: 'TSC', eslintBin: 'ESLINT', gateDir: '.ashlr-gate' };
    const testNames = (specs: ReturnType<typeof phaseASpecs>) => specs.find((spec) => spec.name === 'test-names');
    expect(testNames(phaseASpecs(opts))?.args).toEqual(['scripts/check-test-names.mjs']);
    expect(testNames(phaseASpecs({ ...opts, mergeBase: 'abc123' }))?.args).toEqual([
      'scripts/check-test-names.mjs', '--base', 'abc123',
    ]);
  });

  it('--check typechecks both tsconfig projects with the native compiler', () => {
    expect(checkTypeSpecs({ nodeBin: 'node', tsgoBin: 'TSGO' })).toEqual([
      { name: 'typecheck', cmd: 'node', args: ['TSGO', '--noEmit', '-p', 'tsconfig.json'] },
      { name: 'typecheck-web', cmd: 'node', args: ['TSGO', '--noEmit', '-p', 'src/web-ui/tsconfig.json'] },
    ]);
  });

  it('npm scripts point at the gate and ship scripts', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.gate).toBe('node scripts/gate.mjs');
    expect(pkg.scripts['gate:full']).toBe('node scripts/gate.mjs --full');
    expect(pkg.scripts['ship:local']).toBe('node scripts/ship-local.mjs');
  });
});
