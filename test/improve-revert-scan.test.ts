import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REVERT_SCAN_SCHEMA,
  buildRevertScanReport,
  formatRevertScanReport,
  resolveRevertScanRef,
  revertCandidatesFromExport,
} from '../src/core/improve/revert-scan.js';
import { REVERT_LOG_FORMAT, REVERT_WINDOW_MS } from '../src/core/improve/reverted.js';
import type { ObserveExec } from '../src/core/improve/observe.js';
import { cmdFleetReverts } from '../src/cli/fleet-reverts.js';

const MERGE = 'a'.repeat(40);
const OTHER_MERGE = 'b'.repeat(40);
const REVERT = 'c'.repeat(40);
const HEAD_SHA = 'f'.repeat(40);
const MERGED_AT = '2026-10-27T00:00:00+00:00';
const plus = (hours: number) => new Date(Date.parse(MERGED_AT) + hours * 3_600_000).toISOString();
const commit = (sha: string, at: string, body: string) => `${sha}\x1f${at}\x1f${body}\x1e`;

const prRow = (over: Record<string, unknown> = {}) => ({
  url: 'https://github.com/ashlrai/phantom/pull/5',
  number: 5,
  mergeCommit: { oid: MERGE },
  mergedAt: MERGED_AT,
  ...over,
});

/** Exec that answers the head probe and the history log; records every call. */
function fakeExec(log: string, head: { sha?: string; at?: string } | null = { sha: HEAD_SHA, at: plus(100) }) {
  const calls: string[][] = [];
  const exec: ObserveExec = (_cmd, args) => {
    calls.push(args);
    if (args.includes('-n1')) {
      if (head === null) throw new Error('unknown revision');
      return `${head.sha ?? HEAD_SHA}\x1f${head.at ?? plus(100)}`;
    }
    return log;
  };
  return { exec, calls };
}

const revertedLog = [
  commit(REVERT, plus(10), `Revert "x"\n\nThis reverts commit ${MERGE}.`),
  commit(MERGE, MERGED_AT, 'x (#5)'),
].join('');

describe('revertCandidatesFromExport', () => {
  it('parses a gh JSON array into candidates with repository, number, mergeSha and mergedAt', () => {
    const { candidates, rows, skipped } = revertCandidatesFromExport(JSON.stringify([prRow()]));
    expect(rows).toBe(1);
    expect(skipped).toBe(0);
    expect(candidates).toEqual([{ repository: 'ashlrai/phantom', number: 5, mergeSha: MERGE, mergedAt: MERGED_AT }]);
  });

  it('parses JSONL and a bare mergeCommit string, and skips rows missing identity or merge sha', () => {
    const text = [
      JSON.stringify(prRow({ mergeCommit: OTHER_MERGE })),
      JSON.stringify({ url: 'https://github.com/ashlrai/phantom/pull/6', number: 6, mergeCommit: { oid: 'not-a-sha' } }),
      JSON.stringify({ number: 7, mergeCommit: { oid: MERGE } }),
      'not json at all',
    ].join('\n');
    const { candidates, rows, skipped } = revertCandidatesFromExport(text);
    expect(rows).toBe(4);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ repository: 'ashlrai/phantom', number: 5, mergeSha: OTHER_MERGE });
    expect(skipped).toBe(3);
  });

  it('rejects url/number disagreement and accepts the nameWithOwner fallback', () => {
    const disagree = revertCandidatesFromExport(JSON.stringify([prRow({ number: 9 })]));
    expect(disagree.candidates).toHaveLength(0);
    expect(disagree.skipped).toBe(1);
    const fallback = revertCandidatesFromExport(JSON.stringify([
      { repository: { nameWithOwner: 'ashlrai/phantom' }, number: 8, mergeCommit: MERGE },
    ]));
    expect(fallback.candidates).toEqual([{ repository: 'ashlrai/phantom', number: 8, mergeSha: MERGE, mergedAt: null }]);
  });
});

describe('resolveRevertScanRef', () => {
  it('prefers origin/HEAD, falls back to HEAD, honours an explicit ref and reports failure', () => {
    const { exec, calls } = fakeExec('');
    expect(resolveRevertScanRef('/repo', null, exec)).toEqual({ ref: 'origin/HEAD', sha: HEAD_SHA, at: plus(100) });
    expect(calls[0]).toContain('origin/HEAD');

    // origin/HEAD fails, HEAD succeeds: second call answers.
    let n = 0;
    const flaky: ObserveExec = () => {
      n += 1;
      if (n === 1) throw new Error('unknown revision');
      return `${HEAD_SHA}\x1f${plus(100)}`;
    };
    expect(resolveRevertScanRef('/repo', null, flaky)).toMatchObject({ ref: 'HEAD' });

    expect(resolveRevertScanRef('/repo', 'main', exec)).toMatchObject({ ref: 'main' });
    expect(resolveRevertScanRef('/repo', null, () => { throw new Error('not a repo'); })).toBeNull();
  });
});

describe('buildRevertScanReport', () => {
  it('emits revert.scan.v1 with records, coverage metadata and sorted keys', () => {
    const { exec } = fakeExec(revertedLog);
    const report = buildRevertScanReport({
      repoDir: '/repo',
      prs: [JSON.stringify([prRow()])],
      exec,
    });
    expect(report.schema).toBe(REVERT_SCAN_SCHEMA);
    expect(report.ref).toBe('origin/HEAD');
    expect(report.head).toEqual({ sha: HEAD_SHA, at: plus(100) });
    expect(report.windowMs).toBe(REVERT_WINDOW_MS);
    expect(report.candidates).toEqual({ rows: 1, usable: 1, skipped: 0, duplicates: 0 });
    expect(report.reverts).toHaveLength(1);
    expect(report.reverts[0]).toMatchObject({ pr: 'ashlrai/phantom#5', revertedBy: REVERT });
    expect(report.revertedKeys).toEqual(['ashlrai/phantom#5']);
    expect(report.degraded).toBe(false);
    expect(report.errors).toEqual([]);
  });

  it('counts unreadable exports and duplicate PRs without scanning twice', () => {
    const { exec, calls } = fakeExec(revertedLog);
    const report = buildRevertScanReport({
      repoDir: '/repo',
      prs: [JSON.stringify([prRow()]), null, JSON.stringify([prRow()])],
      exec,
    });
    expect(report.prsFiles).toEqual({ files: 3, unreadable: 1 });
    expect(report.candidates).toMatchObject({ usable: 1, duplicates: 1 });
    expect(report.degraded).toBe(true);
    // One history scan plus one head probe — duplicates never reach git.
    expect(calls.filter((a) => a.includes(`--format=${REVERT_LOG_FORMAT}`))).toHaveLength(1);
  });

  it('skips git entirely when no usable candidates remain', () => {
    const { exec, calls } = fakeExec(revertedLog);
    const report = buildRevertScanReport({ repoDir: '/repo', prs: [null, '[]'], exec });
    expect(report.ref).toBeNull();
    expect(report.head).toBeNull();
    expect(report.reverts).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(report.degraded).toBe(true); // the unreadable file still degrades
  });

  it('marks the scan degraded when no ref resolves or git log fails', () => {
    const dead = fakeExec('', null);
    const noRef = buildRevertScanReport({ repoDir: '/not-a-repo', prs: [JSON.stringify([prRow()])], exec: dead.exec });
    expect(noRef.ref).toBeNull();
    expect(noRef.degraded).toBe(true);
    expect(noRef.errors.length).toBeGreaterThan(0);

    const badLog: ObserveExec = (cmd, args) => {
      if (args.includes('-n1')) return `${HEAD_SHA}\x1f${plus(100)}`;
      throw new Error('fatal: bad object HEAD');
    };
    const failed = buildRevertScanReport({ repoDir: '/repo', prs: [JSON.stringify([prRow()])], exec: badLog });
    expect(failed.ref).toBe('origin/HEAD');
    expect(failed.degraded).toBe(true);
    expect(failed.errors[0]).toContain('log origin/HEAD');
    expect(failed.reverts).toEqual([]);
  });
});

describe('formatRevertScanReport', () => {
  it('states coverage and lists each revert with latency and reland state', () => {
    const { exec } = fakeExec(revertedLog);
    const report = buildRevertScanReport({ repoDir: '/repo', prs: [JSON.stringify([prRow()])], exec });
    const text = formatRevertScanReport(report);
    expect(text).toContain('1 merged PR checked on origin/HEAD');
    expect(text).toContain('ashlrai/phantom#5 reverted by');
    expect(text).toContain('10.0h after merge');
  });
});

describe('cmdFleetReverts', () => {
  const exportsJson = JSON.stringify([prRow()]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the JSON report and exits 0 on a clean scan', async () => {
    const { exec } = fakeExec(revertedLog);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await cmdFleetReverts(['--repo-dir', '/repo', '--prs', 'prs.json', '--json'], {
      read: async () => exportsJson,
      exec,
    });
    expect(code).toBe(0);
    const report = JSON.parse(String(out.mock.calls[0]![0])) as { schema: string; reverts: unknown[] };
    expect(report.schema).toBe(REVERT_SCAN_SCHEMA);
    expect(report.reverts).toHaveLength(1);
  });

  it('exits 1 when every export is unreadable, on scan errors, and 2 on bad usage', async () => {
    const { exec } = fakeExec(revertedLog);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetReverts(['--repo-dir', '/repo', '--prs', 'missing.json'], { read: async () => null, exec })).toBe(1);
    expect(await cmdFleetReverts(['--prs', 'x.json'], { read: async () => exportsJson, exec })).toBe(2);
    expect(await cmdFleetReverts(['--repo-dir', '/repo'], { read: async () => exportsJson, exec })).toBe(2);
    const badLog: ObserveExec = (_cmd, args) => {
      if (args.includes('-n1')) return `${HEAD_SHA}\x1f${plus(100)}`;
      throw new Error('fatal: bad object');
    };
    expect(await cmdFleetReverts(['--repo-dir', '/repo', '--prs', 'prs.json'], { read: async () => exportsJson, exec: badLog })).toBe(1);
  });
});
