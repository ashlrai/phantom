import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { jobPathHistory } from '../src/core/fleet/job-path-history.js';

const OID = 'e'.repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, '0');
const record = (n: number, subject: string) => `${sha(n)}\0d${n}\0${subject}\0\n`;

it('pins the scan to the resolved OID through real git, so the report is reproducible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-history-pin-'));
  const cwd = process.cwd();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'one.txt'), 'a');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-PIN-1): landed (#21)');
    const pinned = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'two.txt'), 'b');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-PIN-2): newer head (#22)');
    // Resolve before the head moves on: this oid is what the report must name.
    const headOid = git('rev-parse', 'HEAD').trim();
    process.chdir(dir);
    // HEAD resolves once inside the call: the report names both the requested label and the immutable oid.
    const head = await jobPathHistory('RQ-PIN-1', 'HEAD', 20);
    expect(head).toMatchObject({ jobId: 'RQ-PIN-1', ref: 'HEAD', resolvedRef: headOid, scanned: 2 });
    expect(head.commits[0]).toMatchObject({ pr: 21, paths: ['one.txt'] });
    // The recorded resolvedRef reproduces exactly the pinned tree even after the ref moved on.
    const replay = await jobPathHistory('RQ-PIN-1', pinned, 20);
    expect(replay).toMatchObject({ ref: pinned, resolvedRef: pinned, scanned: 1, paths: ['one.txt'] });
    const moved = await jobPathHistory('RQ-PIN-2', 'HEAD', 20);
    expect(moved).toMatchObject({ resolvedRef: headOid, paths: ['two.txt'] });
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
});

it.each(['HEAD', 'origin/master'])('resolves %s once, then logs and reads paths on the immutable oid', async ref => {
  const history = record(1, 'bridge(RQ-TARGET-1): landed (#7)')
    + record(2, 'plain commit')
    + record(3, 'bridge(RQ-TARGET-1-EXTRA): prefix lookalike (#8)')
    + record(4, 'bridge(RQ-TARGET-1): again (#9)');
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') {
      // The symbolic ref moved after resolution: scanning it would see an unrelated newer head.
      if (args[3] === ref) return record(9, 'bridge(RQ-OTHER-9): moved head');
      if (args[3] === OID) return history;
      throw new Error('unexpected log ref');
    }
    if (args[0] === 'diff-tree') return `p/${args.at(-2)!.slice(-6)}.ts\0`;
    throw new Error('unexpected git call');
  });
  const result = await jobPathHistory('RQ-TARGET-1', ref, 20, run);
  // Resolution precedes the log scan, which runs on the oid — never the movable ref.
  expect(run.mock.calls[0]![0]).toEqual(['rev-parse', '--verify', `${ref}^{commit}`]);
  expect(run.mock.calls[1]![0]).toEqual(['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', OID, '--']);
  // Path evidence comes from the recorded commit shas only.
  expect(run.mock.calls.filter(call => call[0][0] === 'diff-tree').map(call => call[0].at(-2))).toEqual([sha(1), sha(4)]);
  expect(result).toMatchObject({ ref, resolvedRef: OID, scanBound: 1000, scanned: 4, scanMayBeTruncated: false });
  expect(result.commits.map(commit => commit.sha)).toEqual([sha(1), sha(4)]);
  expect(result.paths).toEqual([`p/${sha(1).slice(-6)}.ts`, `p/${sha(4).slice(-6)}.ts`]);
});

it('accepts a sha256-length resolved oid like the batch contract allows', async () => {
  const oid64 = 'f'.repeat(64);
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${oid64}\n`;
    if (args[0] === 'log') return record(1, 'bridge(RQ-WIDE-1): sha256 repo (#3)');
    return 'wide.ts\0';
  });
  const result = await jobPathHistory('RQ-WIDE-1', 'origin/master', 20, run);
  expect(run.mock.calls[1]![0]).toEqual(['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', oid64, '--']);
  expect(result).toMatchObject({ resolvedRef: oid64, scanned: 1, paths: ['wide.ts'] });
});

it('returns bounded no-match evidence that still names the resolved ref', async () => {
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') return record(1, 'plain') + record(2, 'bridge(RQ-OTHER-9): not us (#5)');
    return 'never\0';
  });
  const result = await jobPathHistory('RQ-ABSENT-3', 'origin/master', 20, run);
  expect(result).toMatchObject({ jobId: 'RQ-ABSENT-3', ref: 'origin/master', resolvedRef: OID,
    scanned: 2, scanMayBeTruncated: false, matchesTruncated: false, commits: [], paths: [] });
  expect(run.mock.calls.filter(call => call[0][0] === 'diff-tree')).toHaveLength(0);
});

it('keeps bound and limit truncation evidence after pinning', async () => {
  const three = record(1, 'bridge(RQ-J-3): a') + record(2, 'plain') + record(3, 'bridge(RQ-J-3): b');
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') return three;
    return 'p\0';
  });
  const limited = await jobPathHistory('RQ-J-3', 'HEAD', 1, run);
  expect(limited).toMatchObject({ resolvedRef: OID, matchesTruncated: true });
  expect(limited.commits.map(commit => commit.sha)).toEqual([sha(1)]);
  // The second matching commit counted toward truncation but cost no diff-tree call.
  expect(run.mock.calls.filter(call => call[0][0] === 'diff-tree')).toHaveLength(1);
  const full = Array.from({ length: 1000 }, (_, i) => record(i + 10, 'bridge(RQ-J-3): x')).join('');
  run.mockImplementation(async (args: string[]) =>
    args[0] === 'rev-parse' ? `${OID}\n` : args[0] === 'log' ? full : 'p\0');
  const bound = await jobPathHistory('RQ-J-3', 'HEAD', 100, run);
  expect(bound).toMatchObject({ resolvedRef: OID, scanned: 1000, scanMayBeTruncated: true, matchesTruncated: true });
});

it('validates job, ref and limit before starting any git process', async () => {
  const run = vi.fn(async () => 'x');
  for (const [job, ref, limit] of [
    ['nope', 'HEAD', 20], ['RQ-', 'HEAD', 20], ['RQ-A B', 'HEAD', 20], ['RQ-A', 'HEAD^', 20],
    ['RQ-A', '../main', 20], ['RQ-A', 'origin/../main', 20], ['RQ-A', 'a..b', 20], ['RQ-A', '', 20],
    ['RQ-A', 'HEAD', 0], ['RQ-A', 'HEAD', 101], ['RQ-A', 'HEAD', 1.5], ['RQ-A', 'HEAD', Number.NaN],
  ] as Array<[string, string, number]>) {
    await expect(jobPathHistory(job, ref, limit, run)).rejects.toThrow('invalid job history arguments');
  }
  expect(run).not.toHaveBeenCalled();
});

it('rejects malformed or missing resolution instead of returning empty evidence', async () => {
  for (const resolved of ['not-an-oid\n', 'deadbeef\n', `${'g'.repeat(40)}\n`, '', `${OID} extra\n`, `${OID}\n${OID}\n`]) {
    const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse' ? resolved : 'unreached');
    await expect(jobPathHistory('RQ-A', 'origin/master', 20, run)).rejects.toThrow('unable to resolve origin/master');
    // The failed pin must stop the scan: a log on the movable ref would fabricate evidence.
    expect(run.mock.calls.filter(call => call[0][0] === 'log')).toHaveLength(0);
  }
  const run = vi.fn(async () => { throw new Error('fatal: Needed a single revision'); });
  await expect(jobPathHistory('RQ-A', 'origin/master', 20, run)).rejects.toThrow('Needed a single revision');
});
