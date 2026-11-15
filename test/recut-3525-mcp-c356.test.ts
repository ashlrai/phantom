/**
 * RQ-PHX-RECUTMCPC356 — recut of PR #3525 (RQ-PHX-MCPCURRENTSNAPSHOT04SQC1):
 * unit-seam coverage for `fleet_job_current_snapshot` on current master. The
 * PR's MCP round-trip test lands beside this file; these cases pin the
 * argument contract, the snapshot OID/ancestor guards and the evidence
 * envelope with injected git — no real repository, daemon or network.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseFleetJobCurrentSnapshotArgs, readFleetJobCurrentSnapshot,
} from '../src/mcp/fleet-job-current-snapshot.js';
import { jobCurrentSnapshot, type JobCurrentSnapshotReport } from '../src/core/fleet/job-current-snapshot.js';

const OID = (c: string) => c.repeat(40);
const SHA1 = OID('a'), PINNED = OID('d'), OTHER = OID('b');
const SNAP64 = 'f'.repeat(64);

const report = (over: Partial<JobCurrentSnapshotReport> = {}): JobCurrentSnapshotReport => ({
  jobId: 'RQ-X-1', resolvedRef: PINNED,
  scanBound: 1000, scanned: 3, scanMayBeTruncated: false, matchesTruncated: false,
  commit: { sha: SHA1, date: '2026-11-01T00:00:00Z', pr: 7 },
  pathBound: 200, omittedPaths: 0,
  summary: { unchanged: 0, changed: 1, absentNow: 0, absentAtBoth: 0 },
  entries: [{ path: 'src/a.ts', status: 'changed',
    atCommit: { mode: '100644', type: 'blob', oid: OID('1') },
    atCurrent: { mode: '100644', type: 'blob', oid: OID('2') } }],
  requestedSnapshot: PINNED,
  caveat: 'Replayed from requestedSnapshot, which was verified as a commit and an ancestor of origin/master at request time.',
  ...over,
});

describe('parseFleetJobCurrentSnapshotArgs', () => {
  it('accepts a job id with a full lowercase 40- or 64-character OID', () => {
    expect(parseFleetJobCurrentSnapshotArgs({ jobId: 'RQ-X-1', snapshot: PINNED }))
      .toEqual({ jobId: 'RQ-X-1', snapshot: PINNED });
    expect(parseFleetJobCurrentSnapshotArgs({ jobId: 'RQ-ABC_9', snapshot: SNAP64 }))
      .toEqual({ jobId: 'RQ-ABC_9', snapshot: SNAP64 });
  });

  it.each([
    {},
    { jobId: 'RQ-X-1' },
    { snapshot: PINNED },
    { jobId: 'RQ-X-1', snapshot: PINNED, ref: 'HEAD' },
    { jobId: 'RQ-X-1', snapshot: PINNED, cwd: '/tmp' },
    { jobId: 'RQ-X-1', snapshot: PINNED, limit: 5 },
    { jobId: 'rq-x-1', snapshot: PINNED },
    { jobId: 'JOB-1', snapshot: PINNED },
    { jobId: 'RQ-', snapshot: PINNED },
    { jobId: 'RQ-X 1', snapshot: PINNED },
    { jobId: 'RQ-X/1', snapshot: PINNED },
    { jobId: 7, snapshot: PINNED },
    { jobId: 'RQ-X-1', snapshot: 'HEAD' },
    { jobId: 'RQ-X-1', snapshot: 'origin/master' },
    { jobId: 'RQ-X-1', snapshot: PINNED.slice(0, 39) },
    { jobId: 'RQ-X-1', snapshot: `${PINNED}0` },
    { jobId: 'RQ-X-1', snapshot: PINNED.toUpperCase() },
    { jobId: 'RQ-X-1', snapshot: SNAP64.toUpperCase() },
    { jobId: 'RQ-X-1', snapshot: `${PINNED}..${OTHER}` },
    { jobId: 'RQ-X-1', snapshot: `g${'0'.repeat(39)}` },
  ])('rejects before any read: %j', args => {
    expect(parseFleetJobCurrentSnapshotArgs(args)).toBeNull();
  });
});

describe('jobCurrentSnapshot guards', () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); return 'commit\n'; };

  it('rejects a malformed OID or job id before any git call', async () => {
    for (const bad of ['HEAD', 'main', PINNED.slice(0, 39), PINNED.toUpperCase()]) {
      await expect(jobCurrentSnapshot(bad, 'RQ-X-1', run)).rejects.toThrow(/invalid/);
    }
    await expect(jobCurrentSnapshot(PINNED, 'JOB-1', run)).rejects.toThrow(/invalid/);
    expect(calls).toEqual([]);
  });

  it('rejects a non-commit OID and a non-ancestor before any scan', async () => {
    const deny = vi.fn(async (args: string[]) => {
      const key = args.join(' ');
      if (key.startsWith('merge-base ')) throw new Error('exit 1');
      return 'commit\n';
    });
    await expect(jobCurrentSnapshot(PINNED, 'RQ-X-1', deny)).rejects.toThrow(/not an ancestor/);
    expect(deny.mock.calls.map(c => c[0])).toEqual([
      ['cat-file', '-t', PINNED], ['merge-base', '--is-ancestor', PINNED, 'origin/master'],
    ]);

    const blob = vi.fn(async () => 'blob\n');
    await expect(jobCurrentSnapshot(PINNED, 'RQ-X-1', blob)).rejects.toThrow(/not a commit/);
    expect(blob.mock.calls.map(c => c[0])).toEqual([['cat-file', '-t', PINNED]]);
  });
});

describe('jobCurrentSnapshot pinned replay', () => {
  it('resolves origin/master to the pinned OID, never running rev-parse', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const key = args.join(' ');
      if (args[0] === 'cat-file') return 'commit\n';
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'log') return `${SHA1}\0${'2026-11-01T00:00:00Z'}\0bridge(RQ-X-1): landed thing (#7)\0`;
      if (args[0] === 'diff-tree') return 'src/a.ts\0';
      if (args[0] === 'ls-tree') return key.startsWith(`ls-tree -z --full-tree ${SHA1} `)
        ? `100644 blob ${OID('1')}\tsrc/a.ts\0`
        : `100644 blob ${OID('2')}\tsrc/a.ts\0`;
      throw new Error(`unexpected git call: ${key}`);
    };
    const out = await jobCurrentSnapshot(PINNED, 'RQ-X-1', run);
    expect(calls.filter(argv => argv[0] === 'rev-parse')).toEqual([]);
    expect(calls.slice(0, 2)).toEqual([
      ['cat-file', '-t', PINNED], ['merge-base', '--is-ancestor', PINNED, 'origin/master'],
    ]);
    // Both ls-tree reads ran on commit OIDs, and the current side is the pin, never the ref name.
    const trees = calls.filter(argv => argv[0] === 'ls-tree').map(argv => argv[3]);
    expect(trees).toEqual([SHA1, PINNED].sort());
    // Only the ancestry check may name the ref; every history and tree read used OIDs.
    const reads = calls.filter(argv => argv[0] !== 'merge-base').flat();
    expect(reads.some(a => a === 'origin/master' || a.startsWith('origin/master^'))).toBe(false);
    expect(out).toMatchObject({
      jobId: 'RQ-X-1', requestedSnapshot: PINNED, resolvedRef: PINNED,
      commit: { sha: SHA1, pr: 7 }, summary: { changed: 1 },
    });
    expect(out).not.toHaveProperty('ref');
    expect(out.caveat).toMatch(/verified as a commit and an ancestor of origin\/master/);
  });
});

describe('readFleetJobCurrentSnapshot envelope', () => {
  it('wraps the shared reader report in the v1 evidence envelope', async () => {
    const read = vi.fn(async () => report());
    const out = await readFleetJobCurrentSnapshot({ jobId: 'RQ-X-1', snapshot: PINNED }, { read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(PINNED, 'RQ-X-1');
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      jobId: 'RQ-X-1', requestedSnapshot: PINNED, resolvedRef: PINNED,
      commit: { sha: SHA1, pr: 7 }, summary: { changed: 1 },
    });
    expect(typeof out.generatedAt).toBe('string');
    expect(out.note).toMatch(/not current live origin\/master/i);
    expect(out.note).toMatch(/does not prove the job never landed/i);
    expect(out.note).toMatch(/never missing work/i);
    expect(out.note).toMatch(/correctness, live lane, dispatch or merge-queue verdict/i);
    expect(out).not.toHaveProperty('ref');
  });

  it('propagates reader failure for the server to sanitize, never fabricating evidence', async () => {
    const read = vi.fn(async () => { throw new Error('fatal: object store gone'); });
    await expect(readFleetJobCurrentSnapshot({ jobId: 'RQ-X-1', snapshot: PINNED }, { read }))
      .rejects.toThrow(/object store gone/);
  });
});
