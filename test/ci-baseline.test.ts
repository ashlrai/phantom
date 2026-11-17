import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function github(options: { count?: number; touched?: string; pass?: boolean; stale?: boolean; unknown?: boolean; unreadable?: boolean; imports?: string; merged?: boolean } = {}) {
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
    else if (endpoint.includes('/contents/')) value = { encoding: 'base64', content: Buffer.from(options.imports ?? "import { it } from 'vitest';").toString('base64') };
    else if (endpoint.includes('/jobs/') && endpoint.endsWith('/logs')) {
      if (options.unreadable) return { ok: false, stdout: '', stderr: '403' };
      const isMaster = endpoint.includes('/jobs/10/');
      return success(`/usr/bin/git log -1 --format=%H\n${isMaster ? master : head}\n${fixture(options.unknown && !isMaster ? 'unknown' : isMaster && options.pass ? 'pass' : 'shared')}`);
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
