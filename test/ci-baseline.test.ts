import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { analyzeCiBaseline, applyBaselineUpdates, enqueueBaselineFixes, parseBaselineFailures } from '../src/core/fleet/ci-baseline.js';
import { cmdCiBaseline } from '../src/cli/ci-baseline.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ci-baseline/${name}.log`, import.meta.url), 'utf8');
const master = 'a'.repeat(40), head = 'b'.repeat(40), merged = 'c'.repeat(40);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

function github(options: { count?: number; touched?: string; pass?: boolean; stale?: boolean; unknown?: boolean; unreadable?: boolean; imports?: string; merged?: boolean; web?: boolean; suite?: boolean; tsc?: boolean; tap?: boolean; docs?: boolean; contents?: Record<string, string>; contentsMiss?: 'error'; contentsError?: string[] } = {}) {
  const calls: string[][] = [];
  const gh: CloudGh = async args => {
    calls.push(args);
    const endpoint = args[1] ?? '';
    let value: unknown;
    const success = (stdout: string) => ({ ok: true, stdout, stderr: '' });
    if (args.includes('PUT')) return success('{}');
    if (args[0] === 'pr') {
      if (args.includes('merged')) value = options.merged ? [{ body: args[args.indexOf('--search') + 1], mergeCommit: { oid: merged } }] : [];
      else value = Array.from({ length: options.count ?? 2 }, (_, i) => ({ number: i + 1, headRefOid: head, headRefName: 'feature', files: [{ path: options.touched ?? 'docs/README.md' }] }));
    } else if (endpoint.includes('/branches/')) value = { commit: { sha: master } };
    else if (endpoint.includes('/compare/')) value = { status: 'ahead' };
    else if (endpoint.includes('/contents/')) {
      const path = endpoint.split('/contents/')[1]!.split('?')[0]!;
      if (path === '') {
        // Root listing for harness-config discovery: immediate children of the
        // fixture repo, files at depth 0 and directories for deeper paths.
        const roots = new Map<string, 'file' | 'dir'>();
        for (const p of Object.keys(options.contents ?? {})) {
          const seg = p.split('/')[0]!;
          roots.set(seg, p.includes('/') ? 'dir' : 'file');
        }
        value = [...roots.entries()].map(([name, type]) => ({ name, path: name, type }));
      } else if (options.contentsError?.includes(path)) {
        return { ok: false, stdout: '', stderr: 'HTTP 500: Internal Server Error' };
      } else if (options.contents) {
        const source = options.contents[path];
        if (source === undefined) {
          if (options.contentsMiss === 'error') return { ok: false, stdout: '', stderr: 'HTTP 500: Internal Server Error' };
          return { ok: false, stdout: '', stderr: 'HTTP 404: Not Found' };
        }
        value = { encoding: 'base64', content: Buffer.from(source).toString('base64') };
      } else {
        value = { encoding: 'base64', content: Buffer.from(options.imports ?? "import { it } from 'vitest';").toString('base64') };
      }
    }
    else if (endpoint.includes('/jobs/') && endpoint.endsWith('/logs')) {
      if (options.unreadable) return { ok: false, stdout: '', stderr: '403' };
      const isMaster = endpoint.includes('/jobs/10/');
      const name = options.unknown && !isMaster ? 'unknown' : isMaster && options.pass ? (options.web ? 'web-pass' : 'pass') : options.suite ? 'suite-shared' : options.tsc ? 'tsc-shared' : options.tap ? 'tap-shared' : options.docs ? 'docs-shared' : options.web ? 'web-shared' : 'shared';
      return success(`/usr/bin/git log -1 --format=%H\n${isMaster ? master : head}\n${fixture(name)}`);
    } else if (endpoint.includes('/jobs?')) {
      const isMaster = endpoint.includes('/runs/1/');
      value = { total_count: 1, jobs: [{ id: isMaster ? 10 : 20, conclusion: isMaster && options.pass ? 'success' : 'failure', head_sha: isMaster ? master : head }] };
    } else if (endpoint.includes('/actions/runs?')) {
      const isMaster = endpoint.includes(master);
      value = { total_count: 1, workflow_runs: [{ id: isMaster ? 1 : 2, workflow_id: 1, status: 'completed', head_sha: isMaster ? master : options.stale ? master : head }] };
    } else throw new Error(`unexpected call ${args.join(' ')}`);
    return success(JSON.stringify(value));
  };
  return { gh, calls };
}

describe('CI baseline evidence', () => {
  it('groups independent failures and keeps analysis read-only', async () => {
    const { gh, calls } = github();
    const report = await analyzeCiBaseline('owner/repo', gh);
    expect(report.groups[0]).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', prs: [1, 2], master: 'fail' });
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(calls.some(c => c.includes('PUT'))).toBe(false);
    expect(report.updates.every(u => !u.ready)).toBe(true);
  });
  it('identifies PR changes to a test or its imports', async () => {
    for (const touched of ['test/example.test.ts', 'package.json']) {
      const report = await analyzeCiBaseline('owner/repo', github({ touched }).gh);
      expect(report.groups[0]?.action).toBe('pr-caused');
    }
    const imported = await analyzeCiBaseline('owner/repo', github({ count: 1, touched: 'test/helper.ts', imports: "import './helper.js';" }).gh);
    expect(imported.groups[0]?.action).toBe('pr-caused');
  });
  it('requires an explicit same-test master pass for a singleton flake', async () => {
    const pass = await analyzeCiBaseline('owner/repo', github({ count: 1, pass: true }).gh);
    expect(pass.groups[0]?.action).toBe('rerun-failed');
    expect(pass.groups[0]?.runs).toEqual([{ pr: 1, head, runId: 2 }]);
    const fail = await analyzeCiBaseline('owner/repo', github({ count: 1 }).gh);
    expect(fail.groups[0]?.action).toBe('unknown');
  });
  it('excludes stale and unreadable or unrecognized logs', async () => {
    for (const options of [{ stale: true }, { unknown: true }, { unreadable: true }]) {
      const report = await analyzeCiBaseline('owner/repo', github(options).gh);
      expect(report.groups).toEqual([]);
      expect(report.freshness.every(p => p.state === (options.stale ? 'stale' : 'unknown'))).toBe(true);
    }
  });
  it('does not infer independence with unresolved imports', async () => {
    const report = await analyzeCiBaseline('owner/repo', github({ imports: "import helper from '#helper';" }).gh);
    expect(report.groups[0]?.classification).toBe('unknown');
  });
  it('parses Vitest project labels and web-ui suite paths', () => {
    const failures = parseBaselineFailures([
      'FAIL  |unit| test/example.test.ts > owner status > reports delivery',
      'AssertionError: expected 1 to be 2',
      'FAIL  |console| src/web-ui/design/tokens.test.tsx > tokens > exposes accent',
      'FAIL src/core/not-a-suite.ts > ignored',
      'FAIL  |unit| test/example.ts > ignored suffix',
      'FAIL  |unit| test/other.test.ts',
    ].join('\n'));
    expect(failures.map(f => f.file)).toEqual(['test/example.test.ts', 'src/web-ui/design/tokens.test.tsx']);
    expect(failures[0]).toMatchObject({ names: 'owner status > reports delivery' });
    expect(failures[0]?.excerpt).toContain('AssertionError: expected 1 to be 2');
    expect(failures[1]?.names).toBe('tokens > exposes accent');
  });
  it('parses suite-load failures as file-level identities', () => {
    const failures = parseBaselineFailures([
      'FAIL  |unit| test/broken.test.ts [ test/broken.test.ts ]',
      "Error: Cannot find module './gone.js' imported from /x/test/broken.test.ts",
      'FAIL  test/bare.test.ts',
      'FAIL  |unit| src/not-web-ui/broken.test.ts [ src/not-web-ui/broken.test.ts ]',
      'FAIL  |unit| test/trailing.test.ts [ test/trailing.test.ts ] extra',
    ].join('\n'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ file: 'test/broken.test.ts', names: '(suite)', testId: 'test/broken.test.ts > (suite)' });
    expect(failures[0]?.excerpt).toContain("Cannot find module './gone.js'");
  });
  it('groups suite-load failures and verifies a master pass by file activity', async () => {
    const broken = await analyzeCiBaseline('owner/repo', github({ suite: true }).gh);
    expect(broken.groups[0]).toMatchObject({ file: 'test/example.test.ts', names: '(suite)', testId: 'test/example.test.ts > (suite)', classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail' });
    const fixed = await analyzeCiBaseline('owner/repo', github({ suite: true, pass: true }).gh);
    expect(fixed.groups[0]).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'pass' });
    expect(fixed.updates.every(u => u.ready)).toBe(true);
    const flake = await analyzeCiBaseline('owner/repo', github({ suite: true, pass: true, count: 1 }).gh);
    expect(flake.groups[0]).toMatchObject({ classification: 'probable-flake', action: 'rerun-failed' });
  });
  it('parses TypeScript diagnostics as per-file typecheck failures', () => {
    const failures = parseBaselineFailures([
      'src/core/example.ts(12,7): error TS2322: Type \'string\' is not assignable to type \'number\'.',
      'src/core/example.ts(40,3): error TS2304: Cannot find name \'missing\'.',
      'src/web-ui/design/tokens.tsx(8,2): error TS7006: Parameter \'x\' implicitly has an \'any\' type.',
      'error TS2688: Cannot find type definition file for \'node\'.',
      'src/../escape.ts(1,1): error TS2322: nope',
      '/abs/path.ts(1,1): error TS2322: nope',
      'src/core/not-a-diagnostic.ts: error TS2322 missing position',
      'plain output line',
    ].join('\n'));
    expect(failures.map(f => f.testId)).toEqual([
      'src/core/example.ts > (typecheck)',
      'src/web-ui/design/tokens.tsx > (typecheck)',
    ]);
    expect(failures[0]?.names).toBe('(typecheck)');
    expect(failures[0]?.excerpt).toContain('TS2322').toContain('TS2304');
    expect(failures[1]?.file).toBe('src/web-ui/design/tokens.tsx');
  });
  it('groups TypeScript diagnostics and queues master fixes for typecheck breaks', async () => {
    const report = await analyzeCiBaseline('owner/repo', github({ tsc: true }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(2);
    for (const group of report.groups) {
      expect(group).toMatchObject({ names: '(typecheck)', classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
      expect(group.brief).toContain(group.testId);
    }
    expect(report.groups.map(g => g.testId)).toEqual(['src/core/example.ts > (typecheck)', 'src/core/other.ts > (typecheck)']);
  });
  it('attributes typecheck failures to PRs touching the failing file or its imports', async () => {
    const caused = await analyzeCiBaseline('owner/repo', github({ tsc: true, touched: 'src/core/example.ts' }).gh);
    const byId = new Map(caused.groups.map(g => [g.testId, g]));
    expect(byId.get('src/core/example.ts > (typecheck)')?.action).toBe('pr-caused');
    expect(byId.get('src/core/other.ts > (typecheck)')?.action).toBe('queue-master-fix');
    const contents = {
      'src/core/example.ts': "import { dep } from './dep.js';\nexport const x: number = dep;",
      'src/core/dep.ts': 'export const dep = 1;',
      'src/core/other.ts': 'export const y = 2;',
    };
    const imported = await analyzeCiBaseline('owner/repo', github({ tsc: true, touched: 'src/core/dep.ts', contents }).gh);
    const importedById = new Map(imported.groups.map(g => [g.testId, g]));
    expect(importedById.get('src/core/example.ts > (typecheck)')?.action).toBe('pr-caused');
    expect(importedById.get('src/core/other.ts > (typecheck)')?.action).toBe('queue-master-fix');
  });
  it('parses node:test TAP failures with hierarchy and file-level identities', () => {
    const tap = (lines: string[]) => parseBaselineFailures(lines.join('\n'), 'owner/repo');
    const block = (indent: string, file: string, line: number, type: string, failureType: string, extra: string[] = []) => [
      `${indent}  ---`,
      `${indent}  type: '${type}'`,
      `${indent}  location: '/home/runner/work/repo/repo/${file}:${line}:1'`,
      `${indent}  failureType: '${failureType}'`,
      ...extra.map(e => `${indent}  ${e}`),
      `${indent}  ...`,
    ];
    const failures = tap([
      'TAP version 13',
      '# Subtest: outer',
      '    # Subtest: inner',
      '        # Subtest: leaf',
      '        not ok 1 - leaf',
      ...block('        ', '.github/tests/nested.test.mjs', 9, 'test', 'testCodeFailure', ["error: |-", '          Expected 1 to be 2', '          ']),
      '        1..1',
      '    ok 1 - inner',
      '      ---',
      "      type: 'suite'",
      '      ...',
      '    1..1',
      'ok 1 - outer',
      '  ---',
      "  type: 'suite'",
      '  ...',
      '# Subtest: hooked',
      '    # Subtest: never runs',
      '    not ok 2 - never runs',
      ...block('    ', '.github/tests/hook.test.mjs', 5, 'test', 'cancelledByParent', ["error: 'cancelled'"]),
      '    1..1',
      'not ok 2 - hooked',
      ...block('', '.github/tests/hook.test.mjs', 3, 'suite', 'hookFailed', ["error: 'before blew up'"]),
      '# Subtest: suite',
      '    # Subtest: child',
      '    not ok 3 - child',
      ...block('    ', '.github/tests/sub.test.mjs', 6, 'test', 'testCodeFailure'),
      '    1..1',
      'not ok 3 - suite',
      ...block('', '.github/tests/sub.test.mjs', 2, 'suite', 'subtestsFailed', ["error: '1 subtest failed'"]),
      '# file:///home/runner/work/repo/repo/.github/tests/loadfail.test.mjs:2',
      "# throw new Error('boom at module load');",
      '# Error: boom at module load',
      '#     at file:///home/runner/work/repo/repo/.github/tests/loadfail.test.mjs:2:7',
      '# Node.js v22.22.3',
      '# Subtest: .github/tests/loadfail.test.mjs',
      'not ok 4 - .github/tests/loadfail.test.mjs',
      ...block('', '.github/tests/loadfail.test.mjs', 1, 'test', 'testCodeFailure', ["exitCode: 1", "error: 'test failed'"]),
      '# Subtest: unresolvable',
      'not ok 5 - unresolvable',
      '  ---',
      "  type: 'test'",
      "  location: '/opt/custom-runner/checkout/.github/tests/elsewhere.test.mjs:3:1'",
      "  failureType: 'testCodeFailure'",
      '  ...',
      '# Subtest: passing',
      'ok 6 - passing',
      '  ---',
      "  type: 'test'",
      '  ...',
      '1..6',
    ]);
    expect(failures.map(f => f.testId)).toEqual([
      '.github/tests/nested.test.mjs > outer > inner > leaf',
      '.github/tests/hook.test.mjs > hooked',
      '.github/tests/sub.test.mjs > suite > child',
      '.github/tests/loadfail.test.mjs > (suite)',
    ]);
    expect(failures[0]?.excerpt).toContain('Expected 1 to be 2');
    expect(failures[1]?.excerpt).toContain('before blew up');
    expect(failures[3]?.excerpt).toContain('boom at module load');
    expect(failures[3]?.excerpt).not.toContain('Node.js v');
    // Without the repo name the absolute location cannot be scoped, so TAP
    // evidence stays unparsed rather than guessed.
    const located = [
      '# Subtest: x',
      'not ok 1 - x',
      '  ---',
      "  type: 'test'",
      "  location: '/home/runner/work/repo/repo/test/x.test.mjs:3:1'",
      '  ...',
    ].join('\n');
    expect(parseBaselineFailures(located)).toEqual([]);
    expect(parseBaselineFailures(located, 'owner/repo')).toHaveLength(1);
  });
  it('groups node:test TAP failures and never resolves a master pass', async () => {
    const report = await analyzeCiBaseline('owner/repo', github({ tap: true }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      file: '.github/tests/example.test.mjs',
      names: 'reports delivery',
      testId: '.github/tests/example.test.mjs > reports delivery',
      classification: 'shared-baseline',
      action: 'queue-master-fix',
      master: 'fail',
    });
    expect(report.groups[0]?.excerpt).toContain("'unknown' !== 'delivered'");
    const caused = await analyzeCiBaseline('owner/repo', github({ tap: true, touched: '.github/tests/example.test.mjs' }).gh);
    expect(caused.groups[0]?.action).toBe('pr-caused');
    // TAP `ok` results carry no file attribution, so a singleton unaffected
    // failure cannot claim a master pass: it stays unknown, never a flake.
    const singleton = await analyzeCiBaseline('owner/repo', github({ tap: true, count: 1, pass: true }).gh);
    expect(singleton.groups[0]).toMatchObject({ classification: 'unknown', action: 'unknown', master: 'unknown' });
  });
  it('parses check:docs JSON reports as per-file documentation failures', () => {
    const failures = parseBaselineFailures(fixture('docs-shared'));
    expect(failures.map(f => f.testId)).toEqual([
      'docs/QUICKSTART.md > (docs-check)',
      'docs/ARCHITECTURE.md > (docs-check)',
    ]);
    expect(failures[0]).toMatchObject({ file: 'docs/QUICKSTART.md', names: '(docs-check)' });
    expect(failures[0]?.excerpt).toContain('docs/DELETED-GUIDE.md#install');
    expect(failures[0]?.excerpt).toContain('ENOENT');
    expect(failures[1]?.excerpt).toContain('#fleet does not exist');
    // Timestamped job-log lines parse the same way.
    const stamped = fixture('docs-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped).map(f => f.testId)).toEqual(failures.map(f => f.testId));
    // Passing reports, malformed blocks, escaping paths and unrelated JSON
    // stay unparsed.
    expect(parseBaselineFailures(JSON.stringify({ ok: true, mode: 'source', errors: [] }, null, 2))).toEqual([]);
    expect(parseBaselineFailures('{\n  "ok": false,\n  "mode": "source",\n  "errors": [\n    {\n      "file": "src/../escape.md",\n      "href": null,\n      "reason": "x"\n    }\n  ]\n}')).toEqual([]);
    expect(parseBaselineFailures('{\n  "unrelated": true,\n  "nested": {\n    "ok": "yes"\n  }\n}')).toEqual([]);
  });
  it('groups documentation-check failures and attributes them to the broken file', async () => {
    const report = await analyzeCiBaseline('owner/repo', github({ docs: true }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(2);
    for (const group of report.groups) {
      expect(group).toMatchObject({ names: '(docs-check)', classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
    }
    const caused = await analyzeCiBaseline('owner/repo', github({ docs: true, touched: 'docs/QUICKSTART.md' }).gh);
    const byId = new Map(caused.groups.map(g => [g.testId, g]));
    expect(byId.get('docs/QUICKSTART.md > (docs-check)')?.action).toBe('pr-caused');
    expect(byId.get('docs/ARCHITECTURE.md > (docs-check)')?.action).toBe('queue-master-fix');
    // Markdown has no import closure: import-looking prose in a document must
    // not fail the dependency check closed.
    const prose = await analyzeCiBaseline('owner/repo', github({
      docs: true,
      contents: { 'docs/QUICKSTART.md': "import x from './gone.js';\nSamples show `from './also-gone'`." },
    }).gh);
    expect(prose.groups.find(g => g.testId === 'docs/QUICKSTART.md > (docs-check)')?.classification).toBe('shared-baseline');
  });
  it('resolves bundler-style imports across the dependency closure', async () => {
    const contents = {
      'test/example.test.ts': "import './helper.js';\nimport './format';\nimport './panes';\nimport './data.json';\nimport './theme.css';\nimport raw from './snippet.ts?raw';",
      'test/helper.ts': 'export const helper = 1;',
      'test/format.tsx': 'export const format = 1;',
      'test/panes/index.ts': 'export const panes = 1;',
      'test/data.json': '{}',
      'test/theme.css': 'body {}',
      'test/snippet.ts': 'export const snippet = 1;',
    };
    const untouched = await analyzeCiBaseline('owner/repo', github({ contents }).gh);
    expect(untouched.groups[0]?.classification).toBe('shared-baseline');
    for (const dep of ['test/helper.ts', 'test/format.tsx', 'test/panes/index.ts', 'test/data.json', 'test/theme.css', 'test/snippet.ts']) {
      const report = await analyzeCiBaseline('owner/repo', github({ contents, touched: dep }).gh);
      expect(report.groups[0]?.action, dep).toBe('pr-caused');
    }
  });
  it('fails closed when a dependency probe errors instead of 404ing', async () => {
    const contents = { 'test/example.test.ts': "import './helper.js';" };
    const report = await analyzeCiBaseline('owner/repo', github({ contents, contentsMiss: 'error' }).gh);
    expect(report.groups[0]?.classification).toBe('unknown');
  });
  it('groups web-ui suite failures and resolves bundler imports', async () => {
    const contents = {
      'src/web-ui/design/tokens.test.tsx': "import { palette } from './palette.js';\nimport sheet from '../global.css';",
      'src/web-ui/design/palette.ts': "import './palette-extra';",
      'src/web-ui/design/palette-extra.tsx': 'export const extra = 1;',
      'src/web-ui/global.css': 'body {}',
    };
    const report = await analyzeCiBaseline('owner/repo', github({ web: true, contents }).gh);
    expect(report.groups[0]).toMatchObject({ file: 'src/web-ui/design/tokens.test.tsx', classification: 'shared-baseline', action: 'queue-master-fix' });
    for (const dep of ['src/web-ui/design/palette.ts', 'src/web-ui/design/palette-extra.tsx', 'src/web-ui/global.css']) {
      const caused = await analyzeCiBaseline('owner/repo', github({ web: true, contents, touched: dep }).gh);
      expect(caused.groups[0]?.action, dep).toBe('pr-caused');
    }
    const flake = await analyzeCiBaseline('owner/repo', github({ web: true, contents, count: 1, pass: true }).gh);
    expect(flake.groups[0]?.action).toBe('rerun-failed');
  });
  it('counts runner-harness files as dependencies of every governed suite', async () => {
    const contents = {
      'test/example.test.ts': "import { it } from 'vitest';",
      'vitest.config.ts': "export default { test: { setupFiles: ['./test/setup/home.ts'] } };",
      'test/setup/home.ts': "import '../../src/core/real-home.js';",
      'src/core/real-home.ts': 'export const home = 1;',
    };
    // A PR breaking the suite through the injected setup file, its imports, the
    // config itself, or the toolchain config is PR-caused — the test's own
    // import closure never sees any of them, so this used to read as a flake.
    for (const touched of ['vitest.config.ts', 'test/setup/home.ts', 'src/core/real-home.ts', 'tsconfig.json']) {
      const report = await analyzeCiBaseline('owner/repo', github({ count: 1, pass: true, touched, contents }).gh);
      expect(report.groups[0]?.action, touched).toBe('pr-caused');
    }
    const flake = await analyzeCiBaseline('owner/repo', github({ count: 1, pass: true, touched: 'docs/README.md', contents }).gh);
    expect(flake.groups[0]?.action).toBe('rerun-failed');
  });
  it('scopes harness deps to the config that governs each suite', async () => {
    const contents = {
      'test/example.test.ts': "import { it } from 'vitest';",
      'vitest.config.ts': "export default { test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup/home.ts'] } };",
      'test/setup/home.ts': 'export {};',
      'src/web-ui/design/tokens.test.tsx': "import { it } from 'vitest';",
      'vitest.config.web.ts': "export default { test: { include: ['src/web-ui/**/*.test.{ts,tsx}'], setupFiles: ['./src/web-ui/test/setup.ts'] } };",
      'src/web-ui/test/setup.ts': 'export {};',
    };
    // The web suite runs under vitest.config.web.ts only: a PR touching the
    // backend config or its setup file leaves the web failure unattributed.
    for (const touched of ['vitest.config.ts', 'test/setup/home.ts']) {
      const report = await analyzeCiBaseline('owner/repo', github({ web: true, contents, touched }).gh);
      expect(report.groups[0]?.action, touched).toBe('queue-master-fix');
    }
    for (const touched of ['vitest.config.web.ts', 'src/web-ui/test/setup.ts']) {
      const report = await analyzeCiBaseline('owner/repo', github({ web: true, contents, touched }).gh);
      expect(report.groups[0]?.action, touched).toBe('pr-caused');
    }
  });
  it('fails closed when a harness probe errors or a setup entry is a glob', async () => {
    const contents = {
      'test/example.test.ts': "import { it } from 'vitest';",
      'vitest.config.ts': "export default { test: { setupFiles: ['./test/setup/home.ts'] } };",
      'test/setup/home.ts': 'export {};',
    };
    const errored = await analyzeCiBaseline('owner/repo', github({ count: 1, pass: true, touched: 'test/setup/home.ts', contents, contentsError: ['vitest.config.ts'] }).gh);
    expect(errored.groups[0]?.classification).toBe('unknown');
    const globbed = { ...contents, 'vitest.config.ts': "export default { test: { setupFiles: ['./test/setup/*.ts'] } };" };
    const globbedReport = await analyzeCiBaseline('owner/repo', github({ count: 1, pass: true, touched: 'test/setup/home.ts', contents: globbed }).gh);
    expect(globbedReport.groups[0]?.classification).toBe('unknown');
  });
  it('handles empty PR lists, invalid repositories, and empty logs', async () => {
    expect((await analyzeCiBaseline('owner/repo', github({ count: 0 }).gh)).groups).toEqual([]);
    await expect(analyzeCiBaseline('../bad', github().gh)).rejects.toThrow('Invalid repository');
    expect(parseBaselineFailures('')).toEqual([]);
  });
  it('caps and scrubs failure summaries', () => {
    const failures = parseBaselineFailures((fixture('shared') + 'AssertionError: ' + 'x'.repeat(4000) + '\n').repeat(150));
    expect(failures).toHaveLength(100);
    expect(failures.every(f => f.excerpt.length <= 2000)).toBe(true);
    const secret = 'ghp_' + 'a'.repeat(36);
    expect(parseBaselineFailures(fixture('shared') + `AssertionError: ${secret}`)[0]?.excerpt).not.toContain(secret);
  });
  it('queues only master-fix briefs at work tier, deduplicated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-baseline-')); dirs.push(dir);
    const path = join(dir, 'router-queue.md');
    const report = await analyzeCiBaseline('owner/repo', github().gh);
    expect(enqueueBaselineFixes(report, path)).toHaveLength(1);
    expect(enqueueBaselineFixes(report, path)).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('tier=work, needs=git|gh|node');
    const caused = await analyzeCiBaseline('owner/repo', github({ touched: 'test/example.test.ts' }).gh);
    expect(enqueueBaselineFixes(caused, path)).toEqual([]);
    expect(() => enqueueBaselineFixes(report, 'relative')).toThrow('absolute');
  });
  it('re-queues a persistent shared-baseline failure as the next generation after DONE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-baseline-')); dirs.push(dir);
    const path = join(dir, 'router-queue.md');
    const report = await analyzeCiBaseline('owner/repo', github().gh);
    const jobId = report.groups.find(g => g.action === 'queue-master-fix')!.jobId;
    expect(enqueueBaselineFixes(report, path)).toEqual([jobId]);
    const queued = readFileSync(path, 'utf8');
    writeFileSync(path, queued.replace(`- READY ${jobId} `, `- DONE ${jobId} `));
    expect(enqueueBaselineFixes(report, path)).toEqual([`${jobId}-G2`]);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(`- READY ${jobId}-G2 (P1, repo=repo, tier=work, needs=git|gh|node): `);
    expect(text).toContain('Stabilization attempt 2');
    expect(text).toContain(`${jobId}-G2`);
    writeFileSync(path, text.replace(`- READY ${jobId}-G2 `, `- DONE ${jobId}-G2 `));
    expect(enqueueBaselineFixes(report, path)).toEqual([`${jobId}-G3`]);
    writeFileSync(path, readFileSync(path, 'utf8').replace(`- READY ${jobId}-G3 `, `- DONE ${jobId}-G3 `));
    expect(enqueueBaselineFixes(report, path)).toEqual([]);
  });
  it('plans updates without mutation, applies only after verified merged fix', async () => {
    const { gh, calls } = github({ pass: true, merged: true });
    const report = await analyzeCiBaseline('owner/repo', gh);
    expect(report.updates).toHaveLength(2);
    expect(calls.some(c => c.includes('PUT'))).toBe(false);
    expect(await applyBaselineUpdates(report, gh)).toEqual([{ pr: 1, state: 'updated' }, { pr: 2, state: 'updated' }]);
    expect(calls.filter(c => c.includes('PUT'))).toHaveLength(2);
    expect(calls.find(c => c.includes('PUT'))).toContain(`expected_head_sha=${head}`);
    const unmerged = github({ pass: true });
    expect((await applyBaselineUpdates(report, unmerged.gh)).every(r => r.state.startsWith('skipped'))).toBe(true);
    expect(unmerged.calls.some(c => c.includes('PUT'))).toBe(false);
  });
  it('rejects malformed CLI arguments before reading GitHub', async () => {
    expect(await cmdCiBaseline(['baseline', '--queue-file', 'relative'])).toBe(2);
    expect(await cmdCiBaseline(['baseline', '--wat'])).toBe(2);
    expect(await cmdCiBaseline(['baseline', '--help'])).toBe(0);
  });
});
