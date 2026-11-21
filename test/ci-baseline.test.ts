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

function github(options: { count?: number; touched?: string; pass?: boolean; stale?: boolean; unknown?: boolean; unreadable?: boolean; imports?: string; merged?: boolean; web?: boolean; suite?: boolean; tsc?: boolean; tap?: boolean; docs?: boolean; generated?: boolean; digest?: boolean; version?: boolean; perf?: boolean; audit?: boolean; pack?: boolean; trust?: boolean; script?: boolean; membench?: boolean; lint?: boolean; lintTestFile?: boolean; flaky?: boolean; gate?: boolean; gateEvidence?: 'fail' | 'pass'; bound?: boolean; boundHead?: string; filePass?: boolean; tree?: { path: string; type?: string; mode?: string }[]; treeError?: boolean; treeTruncated?: boolean; contents?: Record<string, string>; contentsMiss?: 'error'; contentsError?: string[] } = {}) {
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
    else if (endpoint.includes('/git/trees/')) {
      if (options.treeError) return { ok: false, stdout: '', stderr: 'HTTP 500: Internal Server Error' };
      value = { tree: options.tree ?? [], truncated: options.treeTruncated === true };
    }
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
      if (endpoint.includes('/jobs/11/') || endpoint.includes('/jobs/21/')) {
        // Merge Gate style aggregator: no checkout step, so no marker line.
        const gatePass = endpoint.includes('/jobs/11/') && options.pass;
        const gateLog = options.gateEvidence === 'fail' ? fixture('shared') : options.gateEvidence === 'pass' ? fixture('pass') : gatePass
          ? '##[group]Run node <<\'NODE\'\nMerge Gate passed: fast full CI\n##[endgroup]\n'
          : '##[group]Run node <<\'NODE\'\nError: Secret scan (diff) concluded failure\n##[error]Process completed with exit code 1.\n';
        return success(gateLog);
      }
      const isMaster = endpoint.includes('/jobs/10/');
      const name = options.unknown && !isMaster ? 'unknown' : isMaster && options.pass ? (options.filePass ? 'pass-file' : options.web ? 'web-pass' : 'pass') : options.suite ? 'suite-shared' : options.tsc ? 'tsc-shared' : options.tap ? 'tap-shared' : options.docs ? 'docs-shared' : options.generated ? 'generated-shared' : options.digest ? 'digest-shared' : options.version ? 'version-shared' : options.perf ? 'perf-shared' : options.audit ? 'audit-shared' : options.pack ? 'pack-shared' : options.trust ? 'trust-shared' : options.script ? 'script-shared' : options.membench ? 'membench-shared' : options.lint ? 'lint-shared' : options.lintTestFile ? 'lint-test-file' : options.flaky ? 'flaky-shared' : options.web ? 'web-shared' : 'shared';
      const sha = isMaster ? master : head;
      const receipt = options.bound
        ? `Bound candidate ${options.boundHead ?? sha} to event tree ${'e'.repeat(40)}\n`
        : `/usr/bin/git log -1 --format=%H\n${sha}\n`;
      return success(`${receipt}${fixture(name)}`);
    } else if (endpoint.includes('/jobs?')) {
      const isMaster = endpoint.includes('/runs/1/');
      const conclusion = isMaster && options.pass ? 'success' : 'failure';
      const head_sha = isMaster ? master : head;
      const jobs: { id: number; name?: string; conclusion: string; head_sha: string }[] = [{ id: isMaster ? 10 : 20, conclusion, head_sha }];
      if (options.gate) jobs.push({ id: isMaster ? 11 : 21, name: 'Merge Gate', conclusion, head_sha });
      value = { total_count: jobs.length, jobs };
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
  it('reads default-reporter file-pass lines as master pass evidence', async () => {
    // The default reporter prints `✓ file (N tests)` for a green module and
    // no per-test pass lines; a green module means every test in it passed.
    const flake = await analyzeCiBaseline('owner/repo', github({ count: 1, pass: true, filePass: true }).gh);
    expect(flake.groups[0]).toMatchObject({ classification: 'probable-flake', action: 'rerun-failed', master: 'pass' });
    const web = await analyzeCiBaseline('owner/repo', github({ count: 1, pass: true, filePass: true, web: true }).gh);
    expect(web.groups[0]).toMatchObject({ classification: 'probable-flake', action: 'rerun-failed', master: 'pass' });
    const suite = await analyzeCiBaseline('owner/repo', github({ suite: true, pass: true, filePass: true, count: 1 }).gh);
    expect(suite.groups[0]).toMatchObject({ classification: 'probable-flake', action: 'rerun-failed', master: 'pass' });
  });
  it('excludes stale and unreadable or unrecognized logs', async () => {
    for (const options of [{ stale: true }, { unknown: true }, { unreadable: true }]) {
      const report = await analyzeCiBaseline('owner/repo', github(options).gh);
      expect(report.groups).toEqual([]);
      expect(report.freshness.every(p => p.state === (options.stale ? 'stale' : 'unknown'))).toBe(true);
    }
  });
  it('tolerates inert no-checkout aggregator jobs but rejects unverifiable evidence', async () => {
    // Merge Gate never checks out the workspace, so its log cannot carry the
    // checkout SHA marker. An inert aggregator log is dropped from evidence
    // and the run still verifies through the checkout jobs.
    const report = await analyzeCiBaseline('owner/repo', github({ gate: true }).gh);
    expect(report.groups[0]).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', prs: [1, 2], master: 'fail' });
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    const pass = await analyzeCiBaseline('owner/repo', github({ gate: true, pass: true }).gh);
    expect(pass.groups[0]?.master).toBe('pass');
    // Any recognizable failure or pass evidence in an unverifiable log keeps
    // the whole run unknown rather than risking unattributed attribution.
    for (const gateEvidence of ['fail', 'pass'] as const) {
      const poisoned = await analyzeCiBaseline('owner/repo', github({ gate: true, gateEvidence }).gh);
      expect(poisoned.groups).toEqual([]);
      expect(poisoned.freshness.every(p => p.state === 'unknown')).toBe(true);
    }
  });
  it('accepts the source-binding receipt as checkout proof', async () => {
    // Bound CI jobs print `Bound candidate <sha> to event tree|merge ...`
    // instead of a `git log -1` echo; the bound revision must equal head.
    const report = await analyzeCiBaseline('owner/repo', github({ bound: true }).gh);
    expect(report.groups[0]).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', prs: [1, 2], master: 'fail' });
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    const mismatch = await analyzeCiBaseline('owner/repo', github({ bound: true, boundHead: 'f'.repeat(40) }).gh);
    expect(mismatch.groups).toEqual([]);
    expect(mismatch.freshness.every(p => p.state === 'unknown')).toBe(true);
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
  it('parses generated-file staleness and launcher digest failures', () => {
    const failures = parseBaselineFailures(fixture('generated-shared'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ file: 'docs/llms.txt', names: '(generated)', testId: 'docs/llms.txt > (generated)' });
    expect(failures[0]?.excerpt).toContain(' M docs/llms.txt');
    const digest = parseBaselineFailures(fixture('digest-shared'));
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({ file: 'scripts/canonical-launcher-digests.json', names: '(generated)', testId: 'scripts/canonical-launcher-digests.json > (generated)' });
    // Timestamped job-log lines keep the porcelain status column.
    const stamped = fixture('generated-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped).map(f => f.testId)).toEqual(['docs/llms.txt > (generated)']);
    // Porcelain variety: staged rows, untracked, renames, quoted paths; the
    // block ends at the first non-porcelain line and bad paths stay unparsed.
    const varied = parseBaselineFailures([
      'generated files are stale; commit the regenerated tree:',
      'M  src/staged.ts',
      ' M docs/llms.txt',
      '?? docs/new page.md',
      'R  docs/old.md -> docs/new.md',
      ' M "docs/quoted\\"name.md"',
      ' M ../escape.md',
      ' M /abs/path.md',
      ' M docs/\\303\\251.md',
      'not a porcelain row',
      ' M docs/after-break.md',
    ].join('\n'));
    expect(varied.map(f => f.file)).toEqual(['src/staged.ts', 'docs/llms.txt', 'docs/new page.md', 'docs/new.md', 'docs/quoted"name.md']);
    expect(parseBaselineFailures('generated files are stale; commit the regenerated tree:\n##[error]Process completed with exit code 1.')).toEqual([]);
    // The passing digest line and unrelated text produce nothing; the other
    // two failure shapes of the same check still parse.
    expect(parseBaselineFailures(`canonical launcher digest check passed: ${'a'.repeat(64)}`)).toEqual([]);
    expect(parseBaselineFailures('canonical launcher digest list is invalid').map(f => f.file)).toEqual(['scripts/canonical-launcher-digests.json']);
    expect(parseBaselineFailures('canonical launcher digest list differs from bin/ashlr history; run npm run canonical-launcher-digests:regen').map(f => f.file)).toEqual(['scripts/canonical-launcher-digests.json']);
  });
  it('groups generated-file failures and attributes them to generator inputs', async () => {
    const tree = [
      { path: 'docs/README.md', type: 'blob', mode: '100644' },
      { path: 'docs/guide/install.md', type: 'blob', mode: '100644' },
      { path: 'docs/internal/scratch.md', type: 'blob', mode: '100644' },
      { path: 'docs/llms-source.txt', type: 'blob', mode: '100644' },
      { path: 'docs/llms.txt', type: 'blob', mode: '100644' },
      { path: 'src/core/x.ts', type: 'blob', mode: '100644' },
      { path: 'docs/symlinked.md', type: 'blob', mode: '120000' },
      { path: 'docs/tree', type: 'tree' },
    ];
    // llms.txt renders from every public docs page plus the source and
    // generator scripts: a PR touching any of them is the cause.
    for (const touched of ['docs/guide/install.md', 'docs/README.md', 'docs/llms-source.txt', 'scripts/generate-docs-llms.mjs', 'scripts/lib/docs-pages.mjs']) {
      const report = await analyzeCiBaseline('owner/repo', github({ generated: true, touched, tree }).gh);
      expect(report.groups[0], touched).toMatchObject({ testId: 'docs/llms.txt > (generated)', classification: 'pr-caused', action: 'pr-caused', master: 'fail' });
    }
    // docs/internal is not a public page, symlinks and trees are not pages,
    // and unrelated sources share the baseline. Runner-harness files cannot
    // stale a generated artifact either: the clean-tree job never runs vitest.
    for (const touched of ['docs/internal/scratch.md', 'docs/symlinked.md', 'docs/tree', 'src/core/x.ts', 'vitest.config.ts', 'tsconfig.json', 'package.json']) {
      const report = await analyzeCiBaseline('owner/repo', github({ generated: true, touched, tree }).gh);
      expect(report.groups[0], touched).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
    }
  });
  it('fails closed for generated files when the docs tree listing is unusable', async () => {
    const tree = [{ path: 'docs/README.md', type: 'blob', mode: '100644' }];
    for (const options of [{ treeError: true }, { treeTruncated: true }]) {
      const report = await analyzeCiBaseline('owner/repo', github({ generated: true, touched: 'docs/README.md', tree, ...options }).gh);
      expect(report.groups[0]?.classification).toBe('unknown');
    }
  });
  it('groups launcher digest failures and attributes them to bin/ashlr', async () => {
    const caused = await analyzeCiBaseline('owner/repo', github({ digest: true, touched: 'bin/ashlr' }).gh);
    expect(caused.groups[0]).toMatchObject({ testId: 'scripts/canonical-launcher-digests.json > (generated)', classification: 'pr-caused', action: 'pr-caused', master: 'fail' });
    const shared = await analyzeCiBaseline('owner/repo', github({ digest: true, touched: 'src/core/x.ts' }).gh);
    expect(shared.groups[0]).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
  });
  it('parses version-sync drift reports and gate errors', () => {
    const drift = '{"version":"0.0.1","changed":["package-lock.json","desktop/src-tauri/Cargo.toml","README.md"],"matches":false,"check":true}';
    const failures = parseBaselineFailures([
      '> phantom@0.0.0 check:version',
      '> node scripts/sync-candidate-version.mjs --check',
      drift,
      'sync-candidate-version: Candidate package identities do not match Phantom',
    ].join('\n'));
    expect(failures.map(f => f.testId)).toEqual([
      'scripts/sync-candidate-version.mjs > (version-sync)',
      'scripts/sync-candidate-version.mjs > (version-sync)',
    ]);
    expect(failures[0]).toMatchObject({ file: 'scripts/sync-candidate-version.mjs', names: '(version-sync)' });
    expect(failures[0]?.excerpt).toContain('package-lock.json');
    expect(failures[1]?.excerpt).toContain('Candidate package identities');
    // Timestamped job-log lines parse identically.
    const stamped = [drift, 'sync-candidate-version: Expected exactly one main desktop URL']
      .map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped)).toHaveLength(2);
    // Passing reports, write-mode results, empty or unknown changed entries,
    // non-semver versions, malformed or multi-line JSON, and unrelated
    // output stay unparsed.
    for (const bad of [
      '{"version":"0.0.1","changed":[],"matches":false,"check":true}',
      '{"version":"0.0.1","changed":["src/core/x.ts"],"matches":false,"check":true}',
      `{"version":"0.0.1","changed":[${Array.from({ length: 11 }, () => '"package.json"').join(',')}],"matches":false,"check":true}`,
      '{"version":"v0.0.1","changed":["package.json"],"matches":false,"check":true}',
      '{"version":"0.0.1","changed":["package.json"],"matches":true,"check":true}',
      '{"version":"0.0.1","changed":["package.json"],"matches":false,"check":false}',
      '{"version":"0.0.1","changed":"package.json","matches":false,"check":true}',
      '{"unrelated":true}',
      '{\n  "version": "0.0.1",\n  "changed": ["package.json"],\n  "matches": false,\n  "check": true\n}',
      'sync-candidate-version:',
      'prefix sync-candidate-version: not at line start',
    ]) {
      expect(parseBaselineFailures(bad), bad).toEqual([]);
    }
    const secret = 'ghp_' + 'a'.repeat(36);
    expect(parseBaselineFailures(`sync-candidate-version: token ${secret} leaked`)[0]?.excerpt).not.toContain(secret);
  });
  it('groups version-sync failures and attributes them to release metadata', async () => {
    const contents = {
      'scripts/sync-candidate-version.mjs': "import { readFileSync, realpathSync, writeFileSync } from 'node:fs';\nimport { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nexport const synced = 1;",
    };
    const report = await analyzeCiBaseline('owner/repo', github({ version: true, contents }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      file: 'scripts/sync-candidate-version.mjs',
      names: '(version-sync)',
      testId: 'scripts/sync-candidate-version.mjs > (version-sync)',
      classification: 'shared-baseline',
      action: 'queue-master-fix',
      master: 'fail',
      prs: [1, 2],
    });
    expect(report.groups[0]?.brief).toContain('scripts/sync-candidate-version.mjs > (version-sync)');
    // Every file the gate reads is an input: touching any one -- or the gate
    // script itself -- is PR-caused.
    for (const touched of ['package.json', 'package-lock.json', 'server.json', 'desktop/src-tauri/Cargo.toml', 'docs/QUICKSTART.md', 'scripts/sync-candidate-version.mjs']) {
      const caused = await analyzeCiBaseline('owner/repo', github({ version: true, touched, contents }).gh);
      expect(caused.groups[0]?.action, touched).toBe('pr-caused');
    }
    // The vitest harness ambient set cannot reach this gate: runner configs,
    // setup files, toolchain configs and the pnpm lockfile are not inputs.
    for (const touched of ['vitest.config.ts', 'tsconfig.json', 'pnpm-lock.yaml', 'test/setup/home.ts', 'docs/internal/x.md']) {
      const shared = await analyzeCiBaseline('owner/repo', github({ version: true, touched, contents }).gh);
      expect(shared.groups[0]?.classification, touched).toBe('shared-baseline');
    }
    // A singleton unaffected failure can never prove a master pass.
    const singleton = await analyzeCiBaseline('owner/repo', github({ version: true, count: 1, pass: true, contents }).gh);
    expect(singleton.groups[0]).toMatchObject({ classification: 'unknown', action: 'unknown' });
  });
  it('parses perf-budget reports as per-target failures', () => {
    const failures = parseBaselineFailures(fixture('perf-shared'));
    expect(failures.map(f => f.testId)).toEqual([
      'perf/budgets.json > (perf-budget) phm-status',
      'perf/budgets.json > (perf-budget) phm-doctor',
    ]);
    expect(failures[0]).toMatchObject({ file: 'perf/budgets.json', names: '(perf-budget) phm-status' });
    expect(failures[0]?.excerpt).toContain('status=fail');
    expect(failures[0]?.excerpt).toContain('median_ms=1042.6');
    expect(failures[0]?.excerpt).toContain('budget_ms=960');
    expect(failures[0]?.excerpt).toContain('delta_pct=8.6');
    expect(failures[1]?.excerpt).toContain('status=error');
    expect(failures[1]?.excerpt).toContain('command exceeded 60000 ms timeout');
    // Timestamped job-log lines parse the same way.
    const stamped = fixture('perf-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped).map(f => f.testId)).toEqual(failures.map(f => f.testId));
    // Passing reports, skipped-only results, other schemas, malformed or
    // multi-line blocks, absolute or escaping budgets paths, unknown
    // statuses, malformed results and unrelated JSON stay unparsed.
    const report = (results: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
      schema: 'ashlr.perf-budget-report.v1', ok: false, runner: 'hyperfine', budgets: 'perf/budgets.json', results, ...extra,
    }, null, 2);
    for (const bad of [
      report([{ id: 'phm-status', status: 'pass', stats: { median_ms: 1 }, budget_ms: 2, delta_pct: 0 }], { ok: true }),
      report([{ id: 'phantom-wrapper-warm', status: 'skip', why: 'requires_bin "phantom" is not on PATH' }]),
      report([{ id: 'Bad_ID', status: 'fail' }]),
      report([{ id: 'phm-status', status: 'unknown' }]),
      report([{ status: 'fail' }]),
      report(['not-an-object']),
      report([{ id: 'phm-status', status: 'fail' }], { budgets: '/abs/path.json' }),
      report([{ id: 'phm-status', status: 'fail' }], { budgets: '../escape.json' }),
      report([{ id: 'phm-status', status: 'fail' }], { budgets: 42 }),
      JSON.stringify({ schema: 'other.v1', ok: false, budgets: 'perf/budgets.json', results: [{ id: 'x', status: 'fail' }] }, null, 2),
      '{\n  "schema": "ashlr.perf-budget-report.v1",\n  "ok": false,\n  "budgets": "perf/budgets.json",\n  "results": [\n    {\n      "id": "phm-status",\n      "status": "fail"\n    }\n  ]\n',
      '{"schema":"ashlr.perf-budget-report.v1","ok":false,"budgets":"perf/budgets.json","results":[{"id":"phm-status","status":"fail"}]}',
      '{\n  "unrelated": true\n}',
    ]) {
      expect(parseBaselineFailures(bad), bad.slice(0, 80)).toEqual([]);
    }
    const secret = 'ghp_' + 'a'.repeat(36);
    const leaky = report([{ id: 'phm-status', status: 'error', why: `token ${secret} leaked` }]);
    expect(parseBaselineFailures(leaky)[0]?.excerpt).not.toContain(secret);
  });
  it('groups perf-budget failures per target and attributes gate inputs', async () => {
    const report = await analyzeCiBaseline('owner/repo', github({ perf: true }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(2);
    for (const group of report.groups) {
      expect(group).toMatchObject({ file: 'perf/budgets.json', classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
      expect(group.testId).toMatch(/^perf\/budgets\.json > \(perf-budget\) phm-(status|doctor)$/);
      expect(group.brief).toContain(group.testId);
    }
    // The budgets spec, the checker and harness scripts, the launcher and
    // the dependency manifests are all direct inputs: touching any one is
    // PR-caused.
    for (const touched of ['perf/budgets.json', 'scripts/perf-budget.mjs', 'scripts/perf-mcp-tools-list.mjs', 'bin/ashlr', 'package.json', 'package-lock.json']) {
      const caused = await analyzeCiBaseline('owner/repo', github({ perf: true, touched }).gh);
      for (const group of caused.groups) expect(group.action, `${touched} -> ${group.testId}`).toBe('pr-caused');
    }
    // The measured CLI graph has no enumerable closure: src/ changes stay
    // unattributed and share the baseline rather than claiming causation.
    for (const touched of ['src/core/status.ts', 'src/cli/index.ts', 'docs/README.md']) {
      const shared = await analyzeCiBaseline('owner/repo', github({ perf: true, touched }).gh);
      for (const group of shared.groups) expect(group.classification, `${touched} -> ${group.testId}`).toBe('shared-baseline');
    }
    // A singleton unaffected failure can never prove a master pass: the
    // report format has no vitest pass line, so it stays unknown.
    const singleton = await analyzeCiBaseline('owner/repo', github({ perf: true, count: 1, pass: true }).gh);
    for (const group of singleton.groups) expect(group).toMatchObject({ classification: 'unknown', action: 'unknown' });
  });
  it('parses dependency-audit npm reports as per-package failures', () => {
    const failures = parseBaselineFailures(fixture('audit-shared'));
    expect(failures.map(f => f.testId)).toEqual([
      'package-lock.json > (dependency-audit) lodash',
      'package-lock.json > (dependency-audit) minimist',
      'src/raycast/package-lock.json > (dependency-audit) tar',
    ]);
    expect(failures[0]).toMatchObject({ file: 'package-lock.json', names: '(dependency-audit) lodash' });
    expect(failures[0]?.excerpt).toContain('lodash severity=high');
    expect(failures[0]?.excerpt).toContain('GHSA-35JH-R3H4-6JHM');
    expect(failures[0]?.excerpt).toContain('lodash vulnerable to Code Injection');
    expect(failures[0]?.excerpt).toContain('fix=4.17.21');
    expect(failures[1]?.excerpt).toContain('fix=available');
    expect(failures[2]).toMatchObject({ file: 'src/raycast/package-lock.json', names: '(dependency-audit) tar' });
    // Timestamped job-log lines parse identically.
    const stamped = fixture('audit-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped).map(f => f.testId)).toEqual(failures.map(f => f.testId));
  });
  it('filters dependency-audit advisories through the exception fixpoint', () => {
    const invoke = 'bash scripts/npm-audit-with-osv-fallback.sh "root full graph" package-lock.json';
    const auditAdvisory = (id: string) => ({ source: 1, name: 'x', dependency: 'x', title: `advisory ${id}`, url: `https://github.com/advisories/${id}`, severity: 'high', range: '*' });
    const auditVuln = (name: string, via: unknown[]) => ({ name, severity: 'high', isDirect: false, via, effects: [], range: '*', nodes: [`node_modules/${name}`], fixAvailable: true });
    const auditReport = (vulnerabilities: unknown) => JSON.stringify({
      auditReportVersion: 2, vulnerabilities,
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 }, dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 } },
    });
    const lodash = { lodash: auditVuln('lodash', [auditAdvisory('GHSA-35jh-r3h4-6jhm')]) };
    const lodashLog = [invoke, auditReport(lodash)].join('\n');
    // Without exceptions the advisory emits; a matching full-graph
    // exception exempts it end to end.
    expect(parseBaselineFailures(lodashLog)).toHaveLength(1);
    const exceptions = [{ id: 'GHSA-35JH-R3H4-6JHM', package: 'lodash', graph: 'full' as const }];
    expect(parseBaselineFailures(lodashLog, undefined, exceptions)).toEqual([]);
    expect(parseBaselineFailures(lodashLog, undefined, null)).toEqual([]);
    // A package vulnerable only through an exempt package is exempt too
    // (the script's cyclic via-string fixpoint).
    const cyclic = {
      'pkg-a': auditVuln('pkg-a', [auditAdvisory('GHSA-aaaa-bbbb-cccc')]),
      'pkg-b': auditVuln('pkg-b', ['pkg-a']),
    };
    const cyclicExceptions = [{ id: 'GHSA-AAAA-BBBB-CCCC', package: 'pkg-a', graph: 'full' as const }];
    expect(parseBaselineFailures([invoke, auditReport(cyclic)].join('\n'), undefined, cyclicExceptions)).toEqual([]);
    // A second unexcepted advisory keeps the package a real failure.
    const mixed = { lodash: auditVuln('lodash', [auditAdvisory('GHSA-35jh-r3h4-6jhm'), auditAdvisory('GHSA-9999-8888-7777')]) };
    expect(parseBaselineFailures([invoke, auditReport(mixed)].join('\n'), undefined, exceptions)).toHaveLength(1);
    // The root production audit never consults exceptions: the same
    // advisory still emits under --omit=dev on the root lockfile.
    const prodInvoke = 'bash scripts/npm-audit-with-osv-fallback.sh "root production graph" package-lock.json --omit=dev';
    const prodFailures = parseBaselineFailures([prodInvoke, auditReport(lodash)].join('\n'), undefined, exceptions);
    expect(prodFailures.map(f => f.testId)).toEqual(['package-lock.json > (dependency-audit) lodash']);
    // The Raycast production audit consults only raycast-production
    // exceptions and reports against the nested lockfile.
    const raycastProdInvoke = 'bash ../../scripts/npm-audit-with-osv-fallback.sh "Raycast production graph" package-lock.json --omit=dev';
    const tar = { tar: auditVuln('tar', [auditAdvisory('GHSA-34x7-hfp2-rc4v')]) };
    const raycastLog = [raycastProdInvoke, auditReport(tar)].join('\n');
    expect(parseBaselineFailures(raycastLog, undefined, [{ id: 'GHSA-34X7-HFP2-RC4V', package: 'tar', graph: 'full' as const }])).toHaveLength(1);
    const raycastFailures = parseBaselineFailures(raycastLog, undefined, [{ id: 'GHSA-34X7-HFP2-RC4V', package: 'tar', graph: 'raycast-production' as const }]);
    expect(raycastFailures).toEqual([]);
    // Pretty-printed reports parse through the column-0 block scan.
    const pretty = JSON.stringify(JSON.parse(auditReport(lodash)), null, 2);
    expect(parseBaselineFailures([invoke, pretty].join('\n'))).toHaveLength(1);
    // Invalid reports, clean reports and unrelated JSON stay unparsed
    // even with a step echo; a valid report with no step echo does too.
    for (const bad of [
      JSON.stringify({ auditReportVersion: 1, vulnerabilities: lodash, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } }),
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: lodash, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 'x', critical: 0, total: 1 } } }),
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: [], metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }),
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }),
      // Inconsistent document: packages listed under an all-zero count
      // would have passed the gate's clean check, so it emits nothing.
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: lodash, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }),
      '{\n  "auditReportVersion": 2,\n  "vulnerabilities": {',
      '{"unrelated":true}',
    ]) {
      expect(parseBaselineFailures([invoke, bad].join('\n')), bad.slice(0, 80)).toEqual([]);
    }
    expect(parseBaselineFailures(auditReport(lodash))).toEqual([]);
  });
  it('groups dependency-audit failures and attributes lockfile inputs', async () => {
    const contents = { '.github/dependency-audit-exceptions.json': '[]' };
    const report = await analyzeCiBaseline('owner/repo', github({ audit: true, contents }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(3);
    for (const group of report.groups) {
      expect(group).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
      expect(group.brief).toContain(group.testId);
    }
    expect(report.groups.map(g => g.testId)).toEqual([
      'package-lock.json > (dependency-audit) lodash',
      'package-lock.json > (dependency-audit) minimist',
      'src/raycast/package-lock.json > (dependency-audit) tar',
    ]);
    // Each lockfile's manifest, shrinkwrap, .npmrc, the shared exception
    // file and the gate script are inputs: touching any one is
    // PR-caused for that lockfile's groups only.
    const caused = await analyzeCiBaseline('owner/repo', github({ audit: true, touched: 'package-lock.json', contents }).gh);
    const causedById = new Map(caused.groups.map(g => [g.testId, g.action]));
    expect(causedById.get('package-lock.json > (dependency-audit) lodash')).toBe('pr-caused');
    expect(causedById.get('package-lock.json > (dependency-audit) minimist')).toBe('pr-caused');
    expect(causedById.get('src/raycast/package-lock.json > (dependency-audit) tar')).toBe('queue-master-fix');
    const excused = await analyzeCiBaseline('owner/repo', github({ audit: true, touched: '.github/dependency-audit-exceptions.json', contents }).gh);
    for (const group of excused.groups) expect(group.action).toBe('pr-caused');
    const raycast = await analyzeCiBaseline('owner/repo', github({ audit: true, touched: 'src/raycast/package-lock.json', contents }).gh);
    const raycastById = new Map(raycast.groups.map(g => [g.testId, g.action]));
    expect(raycastById.get('src/raycast/package-lock.json > (dependency-audit) tar')).toBe('pr-caused');
    expect(raycastById.get('package-lock.json > (dependency-audit) lodash')).toBe('queue-master-fix');
    // The vitest harness ambient set cannot reach this gate.
    const ambient = await analyzeCiBaseline('owner/repo', github({ audit: true, touched: 'tsconfig.json', contents }).gh);
    for (const group of ambient.groups) expect(group.classification).toBe('shared-baseline');
    // Master's exception file filters the same reports end to end: a
    // full-graph exception for lodash removes its group everywhere.
    const exceptionFile = JSON.stringify([{ id: 'GHSA-35jh-r3h4-6jhm', package: 'lodash', graph: 'full', expires: '2099-01-01T00:00:00Z', reason: 'accepted risk' }]);
    const filtered = await analyzeCiBaseline('owner/repo', github({ audit: true, contents: { '.github/dependency-audit-exceptions.json': exceptionFile } }).gh);
    expect(filtered.groups.map(g => g.testId)).toEqual([
      'package-lock.json > (dependency-audit) minimist',
      'src/raycast/package-lock.json > (dependency-audit) tar',
    ]);
    // An unreadable or malformed exception file disables audit parsing:
    // the failures stay unknown rather than fabricate coverage.
    for (const badContents of [{ '.github/dependency-audit-exceptions.json': 'not json' }, { '.github/dependency-audit-exceptions.json': '{"not":"an array"}' }]) {
      const broken = await analyzeCiBaseline('owner/repo', github({ audit: true, contents: badContents }).gh);
      expect(broken.groups).toEqual([]);
      expect(broken.freshness.every(p => p.state === 'unknown')).toBe(true);
    }
  });
  it('parses pack-smoke and hosted-artifact refusals as gate failures', () => {
    const failures = parseBaselineFailures(fixture('pack-shared'));
    expect(failures.map(f => f.testId)).toEqual([
      '.github/scripts/ci-pack-smoke.mjs > (pack-smoke)',
      'scripts/hosted-build-artifact.mjs > (hosted-artifact)',
    ]);
    expect(failures[0]).toMatchObject({ file: '.github/scripts/ci-pack-smoke.mjs', names: '(pack-smoke)' });
    expect(failures[0]?.excerpt).toContain('pack smoke refused: source changed after build:');
    expect(failures[1]).toMatchObject({ file: 'scripts/hosted-build-artifact.mjs', names: '(hosted-artifact)' });
    expect(failures[1]?.excerpt).toContain('hosted artifact refused: missing built artifact');
    // The drift list continuing under the refusal header is not a second
    // identity and stays out of the excerpt.
    expect(failures[0]?.excerpt).not.toContain('ci-baseline.ts');
    // Timestamped job-log lines parse identically.
    const stamped = fixture('pack-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped).map(f => f.testId)).toEqual(failures.map(f => f.testId));
    // Release-only refusals, empty messages, non-prefixed assert output and
    // unrelated lines stay unparsed.
    for (const bad of [
      'release smoke refused: tarball missing',
      'isolated release tree refused: source drift',
      'Offline partition comparison refused: corpus unreadable',
      'pack smoke refused:',
      'pack smoke refused:   ',
      'AssertionError [ERR_ASSERTION]: expected one npm pack result',
      'same-runner release input refused: verification_failed',
    ]) {
      expect(parseBaselineFailures(bad), bad).toEqual([]);
    }
    const secret = 'ghp_' + 'a'.repeat(36);
    expect(parseBaselineFailures(`pack smoke refused: token ${secret} leaked`)[0]?.excerpt).not.toContain(secret);
  });
  it('groups pack-smoke and artifact failures and attributes gate inputs', async () => {
    const contents = {
      '.github/scripts/ci-pack-smoke.mjs': "import assert from 'node:assert/strict';\nimport { createBuildIdentity } from '../../scripts/build-identity.mjs';\nimport { sourceDrift } from '../../scripts/release-isolated-tree.mjs';",
      'scripts/build-identity.mjs': "import { spawnSync } from 'node:child_process';",
      'scripts/release-isolated-tree.mjs': "import { undeclaredBuildOutputs } from './build-outputs.mjs';",
      'scripts/build-outputs.mjs': "import { existsSync } from 'node:fs';",
      'scripts/hosted-build-artifact.mjs': "import assert from 'node:assert/strict';\nimport { observeBuild } from '../.github/scripts/ci-pack-smoke.mjs';",
    };
    const report = await analyzeCiBaseline('owner/repo', github({ pack: true, contents }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map(g => g.testId)).toEqual([
      '.github/scripts/ci-pack-smoke.mjs > (pack-smoke)',
      'scripts/hosted-build-artifact.mjs > (hosted-artifact)',
    ]);
    for (const group of report.groups) {
      expect(group).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
      expect(group.brief).toContain(group.testId);
    }
    // The gate scripts and their direct manifest inputs are PR-caused; the
    // measured dist/ graph and the vitest harness ambient set cannot reach
    // these plain-script gates, so unrelated changes share the baseline.
    const packInputs = ['package.json', '.github/scripts/ci-pack-smoke.mjs', 'scripts/build-identity.mjs', 'scripts/release-isolated-tree.mjs', 'scripts/build-outputs.mjs'];
    for (const touched of packInputs) {
      const caused = await analyzeCiBaseline('owner/repo', github({ pack: true, touched, contents }).gh);
      const packGroup = caused.groups.find(g => g.testId === '.github/scripts/ci-pack-smoke.mjs > (pack-smoke)');
      expect(packGroup?.action, touched).toBe('pr-caused');
    }
    const artifactInputs = ['package.json', 'package-lock.json', 'scripts/hosted-build-artifact.mjs', '.github/scripts/ci-pack-smoke.mjs'];
    for (const touched of artifactInputs) {
      const caused = await analyzeCiBaseline('owner/repo', github({ pack: true, touched, contents }).gh);
      const artifactGroup = caused.groups.find(g => g.testId === 'scripts/hosted-build-artifact.mjs > (hosted-artifact)');
      expect(artifactGroup?.action, touched).toBe('pr-caused');
    }
    for (const touched of ['src/core/status.ts', 'tsconfig.json', 'vitest.config.ts', 'test/setup/home.ts', 'docs/README.md']) {
      const shared = await analyzeCiBaseline('owner/repo', github({ pack: true, touched, contents }).gh);
      for (const group of shared.groups) expect(group.classification, `${touched} -> ${group.testId}`).toBe('shared-baseline');
    }
    // A singleton unaffected failure can never prove a master pass.
    const singleton = await analyzeCiBaseline('owner/repo', github({ pack: true, count: 1, pass: true, contents }).gh);
    for (const group of singleton.groups) expect(group).toMatchObject({ classification: 'unknown', action: 'unknown' });
  });
  it('parses secret-shape, secret-scan and version-provenance gate failures', () => {
    const failures = parseBaselineFailures(fixture('trust-shared'));
    expect(failures.map(f => f.testId)).toEqual([
      '.github/tests/secret-shape/scrub.pl > (secret-shape)',
      '.github/workflows/ci.yml > (secret-scan)',
      '.github/scripts/release-version-provenance.mjs > (version-provenance)',
    ]);
    expect(failures[0]).toMatchObject({ file: '.github/tests/secret-shape/scrub.pl', names: '(secret-shape)' });
    expect(failures[0]?.excerpt).toBe('3 allowed=1');
    expect(failures[1]).toMatchObject({ file: '.github/workflows/ci.yml', names: '(secret-scan)' });
    expect(failures[1]?.excerpt).toContain('leaks found: 2');
    expect(failures[2]).toMatchObject({ file: '.github/scripts/release-version-provenance.mjs', names: '(version-provenance)' });
    expect(failures[2]?.excerpt).toContain('Only the release-please PR may change the release version');
    // Timestamped job-log lines parse identically.
    const stamped = fixture('trust-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped).map(f => f.testId)).toEqual(failures.map(f => f.testId));
    // The gate-malfunction line groups under the same provenance identity.
    const malfunction = parseBaselineFailures('release version provenance check failed: merge base unavailable');
    expect(malfunction.map(f => f.testId)).toEqual(['.github/scripts/release-version-provenance.mjs > (version-provenance)']);
    // Clean scans, zero counts, the provenance pass line and unrelated
    // error annotations stay unparsed.
    for (const bad of [
      '0 allowed=0',
      '0 allowed=3',
      '2',
      'allowed=2',
      'no leaks found',
      'leaks found: 0',
      'release version provenance: version-unchanged',
      'release version provenance: release-please-pr',
      'release version provenance check failed:',
      '::error::unrelated workflow command failure',
      '::error::package.json version 1 -> 2',
      'Error: Secret scan (diff) concluded failure',
    ]) {
      expect(parseBaselineFailures(bad), bad).toEqual([]);
    }
  });
  it('groups trust-gate failures and attributes each gate its own inputs', async () => {
    const contents = {
      '.github/scripts/release-version-provenance.mjs': "import { execFileSync } from 'node:child_process';\nimport { resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';",
      'package.json': '{"version":"3.30.49"}',
      '.release-please-manifest.json': '{".":"3.30.49"}',
    };
    const report = await analyzeCiBaseline('owner/repo', github({ trust: true, contents }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(3);
    expect(report.groups.map(g => g.testId)).toEqual([
      '.github/scripts/release-version-provenance.mjs > (version-provenance)',
      '.github/tests/secret-shape/scrub.pl > (secret-shape)',
      '.github/workflows/ci.yml > (secret-scan)',
    ]);
    for (const group of report.groups) {
      expect(group).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
      expect(group.brief).toContain(group.testId);
    }
    // Each gate's own definition file is PR-caused for that group only.
    for (const [touched, id] of [
      ['.github/tests/secret-shape/scrub.pl', '.github/tests/secret-shape/scrub.pl > (secret-shape)'],
      ['.github/workflows/ci.yml', '.github/workflows/ci.yml > (secret-scan)'],
      ['package.json', '.github/scripts/release-version-provenance.mjs > (version-provenance)'],
      ['.release-please-manifest.json', '.github/scripts/release-version-provenance.mjs > (version-provenance)'],
      ['.github/scripts/release-version-provenance.mjs', '.github/scripts/release-version-provenance.mjs > (version-provenance)'],
    ] as const) {
      const caused = await analyzeCiBaseline('owner/repo', github({ trust: true, touched, contents }).gh);
      const byId = new Map(caused.groups.map(g => [g.testId, g.action]));
      expect(byId.get(id), touched).toBe('pr-caused');
    }
    // The vitest harness ambient set cannot reach any of these gates, and an
    // unrelated PR touching only toolchain config stays shared-baseline.
    for (const touched of ['tsconfig.json', 'vitest.config.ts', 'src/core/status.ts', 'docs/README.md']) {
      const shared = await analyzeCiBaseline('owner/repo', github({ trust: true, touched, contents }).gh);
      for (const group of shared.groups) expect(group.classification, `${touched} -> ${group.testId}`).toBe('shared-baseline');
    }
    // Without the gate script's contents its dependency closure cannot be
    // proved, so the provenance group stays unknown while the two scanner
    // gates (whose inputs need no fetch) still classify.
    const partial = await analyzeCiBaseline('owner/repo', github({ trust: true, contents: { 'package.json': '{}', '.release-please-manifest.json': '{}' } }).gh);
    const partialById = new Map(partial.groups.map(g => [g.testId, g.classification]));
    expect(partialById.get('.github/scripts/release-version-provenance.mjs > (version-provenance)')).toBe('unknown');
    expect(partialById.get('.github/tests/secret-shape/scrub.pl > (secret-shape)')).toBe('shared-baseline');
    expect(partialById.get('.github/workflows/ci.yml > (secret-scan)')).toBe('shared-baseline');
    // A singleton unaffected failure can never prove a master pass.
    const singleton = await analyzeCiBaseline('owner/repo', github({ trust: true, count: 1, pass: true, contents }).gh);
    for (const group of singleton.groups) expect(group).toMatchObject({ classification: 'unknown', action: 'unknown' });
  });
  it('parses ci.yml helper-gate step failures', () => {
    const failures = parseBaselineFailures(fixture('script-shared'), 'owner/repo');
    expect(failures.map(f => f.testId)).toEqual([
      '.github/tests/ci-fast-select.test.mjs > warm sparse checkout',
      '.github/scripts/ci-fetch-range.mjs > (fetch-range)',
      '.github/scripts/ci-fast-inputs.mjs > (fast-inputs)',
      '.github/scripts/ci-mcp-selection.mjs > (mcp-selection)',
    ]);
    expect(failures[1]).toMatchObject({ file: '.github/scripts/ci-fetch-range.mjs', names: '(fetch-range)' });
    expect(failures[1]?.excerpt).toContain('pull request base is missing');
    expect(failures[2]).toMatchObject({ file: '.github/scripts/ci-fast-inputs.mjs', names: '(fast-inputs)' });
    expect(failures[2]?.excerpt).toContain('tests needs the plan file');
    expect(failures[3]).toMatchObject({ file: '.github/scripts/ci-mcp-selection.mjs', names: '(mcp-selection)' });
    expect(failures[3]?.excerpt).toContain('MCP test selection failed: merge base unavailable');
    // The non-whitelisted ci-fast-select step produced no gate group; its
    // companion TAP failure is the only evidence and stays TAP-owned.
    expect(failures.some(f => f.file === '.github/scripts/ci-fast-select.mjs')).toBe(false);
    // Timestamped job-log lines parse identically.
    const stamped = fixture('script-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped, 'owner/repo').map(f => f.testId)).toEqual(failures.map(f => f.testId));
    const secret = 'ghp_' + 'a'.repeat(36);
    const leaky = [
      '##[group]Run node .github/scripts/ci-fetch-range.mjs',
      'node .github/scripts/ci-fetch-range.mjs',
      'shell: /usr/bin/bash -e {0}',
      '##[endgroup]',
      `fatal: token ${secret} rejected`,
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    expect(parseBaselineFailures(leaky)[0]?.excerpt).not.toContain(secret);
  });
  it('keeps unattributable ci.yml step failures unparsed', () => {
    const step = (script: string[], output: string[], error = '##[error]Process completed with exit code 1.') =>
      ['##[group]Run ' + script[0], ...script.slice(1), 'shell: /usr/bin/bash -e {0}', '##[endgroup]', ...output, error].join('\n');
    // Mixed bash, uses: actions, non-whitelisted scripts, ambiguous
    // multi-script steps, cancelled steps and passing steps stay unparsed.
    for (const bad of [
      step(['set -euo pipefail', 'npm run build'], ['build failed']),
      step(['actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'], ['with:', '  node-version: \'22\'']),
      step(['node .github/scripts/ci-fast-run.mjs'], ['spawn failed']),
      step(['node .github/scripts/ci-pack-smoke.mjs capture "$RUNNER_TEMP"'], ['Error: Cannot find module']),
      step(['node .github/scripts/ci-fetch-range.mjs', 'node .github/scripts/ci-dep-graph.mjs update'], ['boom']),
      step(['node ./.github/scripts/ci-fetch-range.mjs'], ['boom']),
      step(['node .github/scripts/ci-fetch-range.mjs'], ['ok'], '##[error]The operation was canceled.'),
      step(['node .github/scripts/ci-fetch-range.mjs'], ['range fetched'], ''),
    ]) {
      expect(parseBaselineFailures(bad), bad.slice(0, 60)).toEqual([]);
    }
    // A blank line inside the script block does not disqualify the step.
    const blank = [
      '##[group]Run node .github/scripts/ci-fetch-range.mjs',
      'node .github/scripts/ci-fetch-range.mjs',
      '',
      'shell: /usr/bin/bash -e {0}',
      '##[endgroup]',
      'commit range unavailable after unshallow',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    expect(parseBaselineFailures(blank).map(f => f.testId)).toEqual(['.github/scripts/ci-fetch-range.mjs > (fetch-range)']);
    // A companion test failure owns the step: the gate group is suppressed
    // and the TAP `not ok` without a resolvable location emits nothing.
    const suppressed = step(
      ['node --test .github/tests/ci-mcp-selection.test.mjs', 'node --test .github/tests/ci-mcp-selection.test.mjs', 'node .github/scripts/ci-mcp-selection.mjs'],
      ['TAP version 13', 'not ok 1 - selection'],
    );
    expect(parseBaselineFailures(suppressed)).toEqual([]);
    // A vitest FAIL line in a gate step's output suppresses the gate group;
    // the vitest failure itself still parses.
    const vitest = step(
      ['node .github/scripts/ci-mac-rotation.mjs run general'],
      ['FAIL  |unit| test/example.test.ts > suite > case'],
    );
    expect(parseBaselineFailures(vitest).map(f => f.testId)).toEqual(['test/example.test.ts > suite > case']);
  });
  it('groups ci.yml helper-gate failures and attributes workflow and import inputs', async () => {
    const contents = {
      '.github/scripts/ci-fetch-range.mjs': "import { execFileSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';",
      '.github/scripts/ci-fast-inputs.mjs': "import { hashParts } from './ci-green-reuse.mjs';\nimport { changedPaths } from './ci-changed-paths.mjs';\nimport { SCHEMA } from './ci-dep-graph.mjs';",
      '.github/scripts/ci-green-reuse.mjs': "import { createHash } from 'node:crypto';",
      '.github/scripts/ci-changed-paths.mjs': "import { execFileSync } from 'node:child_process';",
      '.github/scripts/ci-dep-graph.mjs': "import { execFileSync } from 'node:child_process';",
      '.github/scripts/ci-mcp-selection.mjs': "import { execFileSync } from 'node:child_process';",
    };
    const report = await analyzeCiBaseline('owner/repo', github({ script: true, contents }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(4);
    expect(report.groups.map(g => g.testId)).toEqual([
      '.github/scripts/ci-fast-inputs.mjs > (fast-inputs)',
      '.github/scripts/ci-fetch-range.mjs > (fetch-range)',
      '.github/scripts/ci-mcp-selection.mjs > (mcp-selection)',
      '.github/tests/ci-fast-select.test.mjs > warm sparse checkout',
    ]);
    for (const group of report.groups.slice(0, 3)) {
      expect(group).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
      expect(group.brief).toContain(group.testId);
    }
    // The workflow step definition, the gate script itself and its import
    // closure are inputs: ci-fast-inputs imports ci-dep-graph, so touching
    // the graph script is PR-caused for the fast-inputs group only.
    for (const [touched, id] of [
      ['.github/workflows/ci.yml', '.github/scripts/ci-fetch-range.mjs > (fetch-range)'],
      ['.github/scripts/ci-fetch-range.mjs', '.github/scripts/ci-fetch-range.mjs > (fetch-range)'],
      ['.github/scripts/ci-dep-graph.mjs', '.github/scripts/ci-fast-inputs.mjs > (fast-inputs)'],
      ['.github/scripts/ci-mcp-selection.mjs', '.github/scripts/ci-mcp-selection.mjs > (mcp-selection)'],
    ] as const) {
      const caused = await analyzeCiBaseline('owner/repo', github({ script: true, touched, contents }).gh);
      const byId = new Map(caused.groups.map(g => [g.testId, g.action]));
      expect(byId.get(id), touched).toBe('pr-caused');
    }
    const depGraph = await analyzeCiBaseline('owner/repo', github({ script: true, touched: '.github/scripts/ci-dep-graph.mjs', contents }).gh);
    const depById = new Map(depGraph.groups.map(g => [g.testId, g.action]));
    expect(depById.get('.github/scripts/ci-fetch-range.mjs > (fetch-range)')).toBe('queue-master-fix');
    expect(depById.get('.github/scripts/ci-mcp-selection.mjs > (mcp-selection)')).toBe('queue-master-fix');
    // The vitest harness ambient set cannot reach these gates, and unrelated
    // changes share the baseline.
    for (const touched of ['tsconfig.json', 'vitest.config.ts', 'src/core/status.ts', 'docs/README.md']) {
      const shared = await analyzeCiBaseline('owner/repo', github({ script: true, touched, contents }).gh);
      for (const group of shared.groups.slice(0, 3)) expect(group.classification, `${touched} -> ${group.testId}`).toBe('shared-baseline');
    }
    // A singleton unaffected failure can never prove a master pass.
    const singleton = await analyzeCiBaseline('owner/repo', github({ script: true, count: 1, pass: true, contents }).gh);
    for (const group of singleton.groups.slice(0, 3)) expect(group).toMatchObject({ classification: 'unknown', action: 'unknown' });
  });
  it('parses memory benchmark floor violations as gate failures', () => {
    const failures = parseBaselineFailures(fixture('membench-shared'));
    expect(failures.map(f => f.testId)).toEqual(['scripts/benchmark-memory.ts > (memory-benchmark)']);
    expect(failures[0]).toMatchObject({ file: 'scripts/benchmark-memory.ts', names: '(memory-benchmark)' });
    expect(failures[0]?.excerpt).toContain('memory benchmark below floor:');
    expect(failures[0]?.excerpt).toContain('overall: 400 passed, floor 407');
    expect(failures[0]?.excerpt).toContain('agent writes validation: 22 duplicate facts served, ceiling 10');
    // Timestamped job-log lines keep the violation indent and parse identically.
    const stamped = fixture('membench-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped).map(f => f.testId)).toEqual(failures.map(f => f.testId));
    expect(parseBaselineFailures(stamped)[0]?.excerpt).toContain('retrieval held-out: 30 passed, floor 34');
    // A bare header, non-indented followers, deeper indents, the passing
    // measurement run and unrelated lines stay unparsed.
    for (const bad of [
      'memory benchmark below floor:',
      'memory benchmark below floor:\noverall: 400 passed, floor 407',
      'memory benchmark below floor:\n    overall: 400 passed, floor 407',
      'memory benchmark below floor:\n  ',
      '  overall: 400 passed, floor 407',
      '{"gate":{"pass":true,"violations":[]}}',
      'npm error code 1',
    ]) {
      expect(parseBaselineFailures(bad), bad.slice(0, 60)).toEqual([]);
    }
    const secret = 'ghp_' + 'a'.repeat(36);
    const leaky = ['memory benchmark below floor:', `  forbidden text leaked token ${secret}`, ''].join('\n');
    expect(parseBaselineFailures(leaky)[0]?.excerpt).not.toContain(secret);
  });
  it('groups memory benchmark failures and attributes closure and toolchain inputs', async () => {
    const contents = {
      'scripts/benchmark-memory.ts': "import { runMemoryBenchmark } from '../src/core/local-eval/memory-benchmark.js';\nimport { memoryBenchmarkFloorViolations } from '../src/core/local-eval/memory-benchmark-floors.js';",
      'src/core/local-eval/memory-benchmark.ts': "import { buildMemoryContextPack } from '../memory/pack.js';",
      'src/core/local-eval/memory-benchmark-floors.ts': "import type { MemoryBenchmarkReport } from './memory-benchmark.js';",
      'src/core/memory/pack.ts': "import { canonicalJson } from '../authority/canonical-json.js';",
      'src/core/authority/canonical-json.ts': 'export {};',
    };
    const report = await analyzeCiBaseline('owner/repo', github({ membench: true, contents }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      testId: 'scripts/benchmark-memory.ts > (memory-benchmark)',
      classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2],
    });
    expect(report.groups[0]?.brief).toContain('scripts/benchmark-memory.ts > (memory-benchmark)');
    // The gate script, its import closure and the seeded toolchain inputs
    // are PR-caused; the vitest harness ambient set cannot reach a tsx
    // gate, so harness and unrelated changes share the baseline.
    for (const touched of [
      'scripts/benchmark-memory.ts',
      'src/core/local-eval/memory-benchmark.ts',
      'src/core/local-eval/memory-benchmark-floors.ts',
      'src/core/memory/pack.ts',
      'src/core/authority/canonical-json.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
    ]) {
      const caused = await analyzeCiBaseline('owner/repo', github({ membench: true, touched, contents }).gh);
      expect(caused.groups[0]?.action, touched).toBe('pr-caused');
    }
    for (const touched of ['vitest.config.mock-compat.ts', 'vitest.config.ts', 'test/setup/home.ts', 'pnpm-lock.yaml', 'src/core/status.ts', 'docs/README.md']) {
      const shared = await analyzeCiBaseline('owner/repo', github({ membench: true, touched, contents }).gh);
      expect(shared.groups[0]?.classification, `${touched} -> shared`).toBe('shared-baseline');
    }
    // Without the entry script's contents its dependency closure cannot be
    // proved, so the group stays unknown rather than guess at attribution.
    const partial = await analyzeCiBaseline('owner/repo', github({ membench: true, contents: {} }).gh);
    expect(partial.groups[0]?.classification).toBe('unknown');
    // A singleton unaffected failure can never prove a master pass.
    const singleton = await analyzeCiBaseline('owner/repo', github({ membench: true, count: 1, pass: true, contents }).gh);
    expect(singleton.groups[0]).toMatchObject({ classification: 'unknown', action: 'unknown' });
  });
  it('parses eslint stylish output as per-file lint failures', () => {
    const failures = parseBaselineFailures(fixture('lint-shared'), 'owner/repo');
    expect(failures.map(f => f.testId)).toEqual([
      'src/core/example.ts > (lint)',
      'src/core/other.ts > (lint)',
    ]);
    expect(failures[0]).toMatchObject({ file: 'src/core/example.ts', names: '(lint)' });
    expect(failures[0]?.excerpt).toContain('no-console');
    expect(failures[1]?.excerpt).toContain('no-unused-vars');
    // Timestamped job-log lines keep the path header and message rows.
    const stamped = fixture('lint-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped, 'owner/repo').map(f => f.testId)).toEqual(failures.map(f => f.testId));
  });
  it('keeps unrecognized lint output unparsed', () => {
    // No `✖ N problems` summary means the stylish block is not eslint's.
    expect(parseBaselineFailures([
      '/home/runner/work/repo/repo/src/core/example.ts',
      '  12:7  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any',
    ].join('\n'), 'owner/repo')).toEqual([]);
    // Absolute paths outside the Actions checkout marker stay unparsed.
    for (const header of [
      '/other/layout/src/core/example.ts',
      '/home/runner/work/repo/repo/../escape.ts',
      '/home/runner/work/repo/repo/src/core/example.md',
      'src/core/example.ts',
    ]) {
      expect(parseBaselineFailures([
        header,
        '  12:7  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any',
        '✖ 1 problem (1 error, 0 warnings)',
      ].join('\n'), 'owner/repo'), header).toEqual([]);
    }
    // Warnings never fail `eslint .` without --max-warnings: a warnings-only
    // file emits nothing even when the summary reports problems.
    expect(parseBaselineFailures([
      '/home/runner/work/repo/repo/src/core/example.ts',
      '  12:7  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any',
      '✖ 1 problem (0 errors, 1 warning)',
    ].join('\n'), 'owner/repo')).toEqual([]);
    // Orphan message rows with no file header attach to nothing.
    expect(parseBaselineFailures([
      '  12:7  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any',
      '✖ 1 problem (1 error, 0 warnings)',
    ].join('\n'), 'owner/repo')).toEqual([]);
  });
  it('groups lint failures and attributes lint inputs, never imports', async () => {
    const report = await analyzeCiBaseline('owner/repo', github({ lint: true }).gh);
    expect(report.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(report.groups).toHaveLength(2);
    for (const group of report.groups) {
      expect(group).toMatchObject({ names: '(lint)', classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2] });
      expect(group.brief).toContain(group.testId);
    }
    expect(report.groups.map(g => g.testId)).toEqual(['src/core/example.ts > (lint)', 'src/core/other.ts > (lint)']);
    // The failing file itself is pr-caused; so are the flat config and the
    // dependency manifests. A file the failing source merely imports is
    // not: eslint's rules are per-file and never read the import closure.
    const caused = await analyzeCiBaseline('owner/repo', github({ lint: true, touched: 'src/core/example.ts' }).gh);
    const byId = new Map(caused.groups.map(g => [g.testId, g]));
    expect(byId.get('src/core/example.ts > (lint)')?.action).toBe('pr-caused');
    expect(byId.get('src/core/other.ts > (lint)')?.action).toBe('queue-master-fix');
    for (const touched of ['eslint.config.js', 'package.json', 'package-lock.json']) {
      const config = await analyzeCiBaseline('owner/repo', github({ lint: true, touched }).gh);
      expect(config.groups.every(g => g.action === 'pr-caused'), touched).toBe(true);
    }
    const contents = {
      'src/core/example.ts': "import { dep } from './dep.js';\nexport const x = dep;",
      'src/core/dep.ts': 'export const dep = 1;',
      'src/core/other.ts': 'export const y = 2;',
    };
    const imported = await analyzeCiBaseline('owner/repo', github({ lint: true, touched: 'src/core/dep.ts', contents }).gh);
    expect(imported.groups.every(g => g.action === 'queue-master-fix')).toBe(true);
    // The vitest harness ambient set cannot reach a lint failure either.
    const ambient = await analyzeCiBaseline('owner/repo', github({ lint: true, touched: 'vitest.config.ts' }).gh);
    expect(ambient.groups.every(g => g.action === 'queue-master-fix')).toBe(true);
  });
  it('never resolves lint failures through vitest pass lines', async () => {
    // A lint break on a test file must not read probable-flake: a green
    // vitest module says nothing about eslint, so the group stays unknown.
    const flake = await analyzeCiBaseline('owner/repo', github({ lintTestFile: true, count: 1, pass: true, filePass: true }).gh);
    expect(flake.groups[0]).toMatchObject({ testId: 'test/example.test.ts > (lint)', classification: 'unknown', action: 'unknown', master: 'unknown' });
    // Two unaffected PRs still group shared-baseline on a test path.
    const shared = await analyzeCiBaseline('owner/repo', github({ lintTestFile: true }).gh);
    expect(shared.groups[0]).toMatchObject({ classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail' });
  });
  it('parses qualification-lane flaky verdicts as test failures', () => {
    // ci-qualification-lane.mjs fails the lane when a Vitest case passes
    // only after a retry; the JSON reporter's fullName joins ancestor
    // titles with spaces, so the identity is `file > names` verbatim.
    const failures = parseBaselineFailures(fixture('flaky-shared'), 'owner/repo');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      file: 'test/example.test.ts',
      names: 'owner status reports delivery',
      testId: 'test/example.test.ts > owner status reports delivery',
    });
    expect(failures[0]?.excerpt).toContain('passed only after a failed attempt (flaky)');
    const multi = parseBaselineFailures([
      'Test case passed only after a failed attempt (flaky): test/example.test.ts > owner status reports delivery',
      'Test case passed only after a failed attempt (flaky): src/web-ui/design/tokens.test.tsx > tokens exposes accent',
      '##[error]Process completed with exit code 1.',
    ].join('\n'), 'owner/repo');
    expect(multi.map(f => f.testId)).toEqual([
      'test/example.test.ts > owner status reports delivery',
      'src/web-ui/design/tokens.test.tsx > tokens exposes accent',
    ]);
    // Timestamped job-log lines keep the verdict.
    const stamped = fixture('flaky-shared').split('\n').map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    expect(parseBaselineFailures(stamped, 'owner/repo').map(f => f.testId)).toEqual(failures.map(f => f.testId));
  });
  it('keeps unrecognized qualification output unparsed', () => {
    for (const line of [
      // Only the vitest suite paths the qualification lanes run.
      'Test case passed only after a failed attempt (flaky): src/core/example.ts > suite case',
      'Test case passed only after a failed attempt (flaky): test/../escape.test.ts > suite case',
      'Test case passed only after a failed attempt (flaky): /abs/test/example.test.ts > suite case',
      // The verdict requires both the file and the case name.
      'Test case passed only after a failed attempt (flaky): test/example.test.ts',
      'Test case passed only after a failed attempt (flaky): test/example.test.ts > ',
      // Near-miss wording from other tooling stays unattributed.
      'Test case passed only after failed attempt: test/example.test.ts > suite case',
      'Test passed only after a failed attempt (flaky): test/example.test.ts > suite case',
    ]) {
      expect(parseBaselineFailures(line, 'owner/repo'), line).toEqual([]);
    }
  });
  it('groups flaky verdicts and resolves a singleton through master pass evidence', async () => {
    // The flaky verdict names a real test, so dependency attribution is
    // the same as a vitest FAIL: repeated on unaffected PRs it is a
    // shared baseline, and master printing it too marks master 'fail'.
    const shared = await analyzeCiBaseline('owner/repo', github({ flaky: true }).gh);
    expect(shared.freshness.map(p => p.state)).toEqual(['fresh', 'fresh']);
    expect(shared.groups).toHaveLength(1);
    expect(shared.groups[0]).toMatchObject({
      testId: 'test/example.test.ts > owner status reports delivery',
      classification: 'shared-baseline', action: 'queue-master-fix', master: 'fail', prs: [1, 2],
    });
    // A one-off flake on an unaffected singleton with a green master
    // module is probable-flake: rerun evidence, never a fabricated pass.
    const flake = await analyzeCiBaseline('owner/repo', github({ flaky: true, count: 1, pass: true, filePass: true }).gh);
    expect(flake.groups[0]).toMatchObject({ classification: 'probable-flake', action: 'rerun-failed', master: 'pass' });
    // A PR that touches the flaky test (or its imports) owns the flake.
    const caused = await analyzeCiBaseline('owner/repo', github({ flaky: true, touched: 'test/example.test.ts' }).gh);
    expect(caused.groups[0]?.action).toBe('pr-caused');
  });
  it('keeps TAP indentation on timestamped job-log lines', () => {
    const block = [
      'TAP version 13',
      '# Subtest: outer',
      '    # Subtest: inner',
      '        not ok 1 - leaf',
      '          ---',
      "          type: 'test'",
      "          location: '/home/runner/work/repo/repo/.github/tests/nested.test.mjs:9:1'",
      "          failureType: 'testCodeFailure'",
      '          ...',
      '        1..1',
      '    1..1',
      '1..1',
    ];
    const stamped = block.map(l => `2026-01-01T00:00:00.0000000Z ${l}`).join('\n');
    const failures = parseBaselineFailures(stamped, 'owner/repo');
    expect(failures.map(f => f.testId)).toEqual(['.github/tests/nested.test.mjs > outer > inner > leaf']);
    expect(parseBaselineFailures(block.join('\n'), 'owner/repo').map(f => f.testId)).toEqual(failures.map(f => f.testId));
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
