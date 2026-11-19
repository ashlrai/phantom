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

function github(options: { count?: number; touched?: string; pass?: boolean; stale?: boolean; unknown?: boolean; unreadable?: boolean; imports?: string; merged?: boolean; web?: boolean; contents?: Record<string, string>; contentsMiss?: 'error'; contentsError?: string[] } = {}) {
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
      const name = options.unknown && !isMaster ? 'unknown' : isMaster && options.pass ? (options.web ? 'web-pass' : 'pass') : options.web ? 'web-shared' : 'shared';
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
