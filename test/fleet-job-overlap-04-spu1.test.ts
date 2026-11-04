import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetJobOverlap } from '../src/cli/fleet-job-overlap.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { jobOverlap } from '../src/core/fleet/job-overlap.js';

const OID = 'e'.repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, '0');
const record = (n: number, subject: string) => `${sha(n)}\0d${n}\0${subject}\0\n`;

it('groups literal paths shared by landed jobs, through the production dispatch convention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-overlap-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    write('shared/one.ts', 'a'); write('only-a.ts', 'a'); write('Dir/Case_File-v2.ts', 'a');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-AAA-1): first job (#11)');
    write('shared/plain-only.ts', 'p');
    git('add', '.'); git('commit', '-m', 'plain cleanup touches shared/plain-only.ts');
    write('shared/one.ts', 'b'); write('only-b.ts', 'b');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-BBB-2): second job (#12)');
    write('Dir/Case_File-v2.ts', 'c'); write('only-c.ts', 'c');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-CCC-3): third job (#13)');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const oid = git('rev-parse', 'HEAD').trim();
    process.chdir(dir);
    // The real dispatcher routes `fleet job-overlap` to the convention export.
    expect(await cmdFleet(['job-overlap', 'RQ-AAA-1', 'RQ-BBB-2', 'RQ-CCC-3', 'RQ-MISSING-9', '--json'])).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out.schemaVersion).toBe(1);
    expect(out.ref).toBe('origin/master');
    expect(out.resolvedRef).toBe(oid);
    expect(out).toMatchObject({ scanBound: 1000, scanned: 4, scanMayBeTruncated: false, limit: 20, evidenceMayBeIncomplete: false });
    expect(out.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-AAA-1', 'RQ-BBB-2', 'RQ-CCC-3', 'RQ-MISSING-9']);
    expect(out.jobs[0]).toMatchObject({ commits: 1, paths: 3, matchesTruncated: false });
    expect(out.jobs[1]).toMatchObject({ commits: 1, paths: 2, matchesTruncated: false });
    expect(out.jobs[2]).toMatchObject({ commits: 1, paths: 2, matchesTruncated: false });
    expect(out.jobs[3]).toMatchObject({ commits: 0, paths: 0, matchesTruncated: false });
    // Literal paths keep case and punctuation; groups sort deterministically
    // ('D' < 's' in code units); each group lists requested ids in input
    // order. The absent id and the non-bridge commit contributed nothing, and
    // single-job paths (only-*.ts, shared/plain-only.ts) never group.
    expect(out.sharedPaths).toEqual([
      { path: 'Dir/Case_File-v2.ts', jobIds: ['RQ-AAA-1', 'RQ-CCC-3'] },
      { path: 'shared/one.ts', jobIds: ['RQ-AAA-1', 'RQ-BBB-2'] },
    ]);
    expect(out.note).toContain('never proof of safety');
    // The registry loader the dispatcher consulted resolves to this export.
    expect((await FLEET_SUBCOMMAND_LOADERS['job-overlap']!()).cmdFleetJobOverlap).toBe(cmdFleetJobOverlap);
    // Group member order follows the request, not job recency.
    expect(await cmdFleetJobOverlap(['RQ-CCC-3', 'RQ-AAA-1', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).sharedPaths)
      .toEqual([{ path: 'Dir/Case_File-v2.ts', jobIds: ['RQ-CCC-3', 'RQ-AAA-1'] }]);
    // Text mode reports per-job counts and each shared path's owners.
    expect(await cmdFleetJobOverlap(['RQ-AAA-1', 'RQ-BBB-2'])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('Shared paths (1):'))).toBe(true);
    expect(lines.some(line => line.includes('shared/one.ts: RQ-AAA-1, RQ-BBB-2'))).toBe(true);
    // A batch with no shared paths reports bounded-empty evidence, never safety.
    expect(await cmdFleetJobOverlap(['RQ-BBB-2', 'RQ-CCC-3'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('not proof of safety or permission to dispatch');
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('serves every id from one resolved OID and one bounded log scan', async () => {
  const history = record(1, 'bridge(RQ-JOB-1): one (#31)')
    + record(2, 'plain commit')
    + record(3, 'bridge(RQ-JOB-2): two (#32)')
    + record(4, 'bridge(RQ-JOB-1): again (#33)');
  const diff = new Map([[sha(1), 'a.ts\0shared.ts\0'], [sha(3), 'b.ts\0shared.ts\0'], [sha(4), 'c.ts\0shared.ts\0']]);
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') return history;
    if (args[0] === 'diff-tree') return diff.get(args.at(-2)!) ?? '';
    throw new Error('unexpected git call');
  });
  const result = await jobOverlap(['RQ-JOB-1', 'RQ-JOB-2'], 20, run);
  // One reader invocation: a single ref resolution and a single log scan for both ids.
  expect(run.mock.calls.filter(call => call[0][0] === 'rev-parse')).toEqual([
    [['rev-parse', '--verify', 'origin/master^{commit}']],
  ]);
  expect(run.mock.calls.filter(call => call[0][0] === 'log')).toEqual([
    [['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', OID, '--']],
  ]);
  expect(result.sharedPaths).toEqual([{ path: 'shared.ts', jobIds: ['RQ-JOB-1', 'RQ-JOB-2'] }]);
  expect(result.jobs).toEqual([
    { jobId: 'RQ-JOB-1', commits: 2, paths: 3, matchesTruncated: false },
    { jobId: 'RQ-JOB-2', commits: 1, paths: 2, matchesTruncated: false },
  ]);
});

it('propagates per-id result truncation and scan-bound truncation honestly', async () => {
  const history = record(1, 'bridge(RQ-A-1): a') + record(2, 'bridge(RQ-A-1): b')
    + record(3, 'bridge(RQ-B-2): c') + record(4, 'bridge(RQ-B-2): d');
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') return history;
    return `unique-${args.at(-2)!.slice(-2)}.ts\0same.ts\0`;
  });
  const limited = await jobOverlap(['RQ-A-1', 'RQ-B-2'], 1, run);
  expect(limited.jobs[0]).toMatchObject({ commits: 1, matchesTruncated: true });
  expect(limited.jobs[1]).toMatchObject({ commits: 1, matchesTruncated: true });
  expect(limited.evidenceMayBeIncomplete).toBe(true);
  // Overlap still reports only what kept commits touched: one diff-tree per kept commit.
  expect(run.mock.calls.filter(call => call[0][0] === 'diff-tree')).toHaveLength(2);
  expect(limited.sharedPaths).toEqual([{ path: 'same.ts', jobIds: ['RQ-A-1', 'RQ-B-2'] }]);
  const full = Array.from({ length: 1000 }, (_, i) => record(i + 10, 'bridge(RQ-A-1): x')).join('');
  run.mockImplementation(async (args: string[]) => args[0] === 'rev-parse' ? `${OID}\n` : args[0] === 'log' ? full : 'p\0');
  const bound = await jobOverlap(['RQ-A-1', 'RQ-Z-9'], 20, run);
  expect(bound).toMatchObject({ scanned: 1000, scanMayBeTruncated: true, evidenceMayBeIncomplete: true });
  expect(bound.jobs[1]).toMatchObject({ jobId: 'RQ-Z-9', commits: 0, paths: 0 });
});

it('validates ids and limit before invoking git, and propagates git failure', async () => {
  const run = vi.fn(async () => 'x');
  for (const [ids, limit] of [
    [[], 20],
    [['RQ-A'], 20],
    [Array.from({ length: 21 }, (_, i) => `RQ-${i}`), 20],
    [['RQ-A', 'RQ-A'], 20],
    [['nope', 'RQ-B'], 20], [['rq-a', 'RQ-B'], 20], [['RQ-A B', 'RQ-C'], 20],
    [['RQ-A', 'RQ-B'], 0], [['RQ-A', 'RQ-B'], 101], [['RQ-A', 'RQ-B'], 1.5], [['RQ-A', 'RQ-B'], '20'],
  ] as Array<[string[], number]>) {
    await expect(jobOverlap(ids, limit, run)).rejects.toThrow('invalid job overlap arguments');
  }
  expect(run).not.toHaveBeenCalled();
  run.mockRejectedValue(new Error('fatal: not a git repository'));
  await expect(jobOverlap(['RQ-A', 'RQ-B'], 20, run)).rejects.toThrow('not a git repository');
});

it('rejects invalid arguments before git and reports read failure without fabricating evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-overlap-nogit-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // Not a git repository: a 2 proves rejection happened before any git call (which would exit 1).
    process.chdir(dir);
    for (const args of [
      [] as string[], ['RQ-A'], ['--json'], ['RQ-A', '--json'], ['--limit', '5', 'RQ-A'],
      ['RQ-A', 'RQ-A'], ['nope', 'RQ-B'], ['rq-a', 'RQ-B'], ['RQ-A B', 'RQ-C'],
      ['RQ-A', 'RQ-B', '--limit', '0'], ['RQ-A', 'RQ-B', '--limit', '101'],
      ['RQ-A', 'RQ-B', '--limit', 'x'], ['RQ-A', 'RQ-B', '--limit'],
      ['RQ-A', 'RQ-B', '--bogus'], ['RQ-A', 'RQ-B', '--ref', 'HEAD'],
      ['RQ-A', 'RQ-B', '--json', '--json'], ['RQ-A', 'RQ-B', '--limit', '5', '--limit', '6'],
      Array.from({ length: 21 }, (_, i) => `RQ-${i}`),
    ]) {
      expect(await cmdFleetJobOverlap(args)).toBe(2);
    }
    expect(await cmdFleetJobOverlap(['--help'])).toBe(0);
    const help = String(log.mock.calls.at(-1)![0]);
    expect(help).toContain('Usage: ashlr fleet job-overlap');
    expect(help).toContain('landed');
    expect(help).toContain('queued claims');
    expect(await cmdFleetJobOverlap(['RQ-A', 'RQ-B'])).toBe(1);
    expect(error.mock.calls.at(-1)![0]).toContain('unable to read job overlap');
    expect(log.mock.calls.some(call => String(call[0]).includes('"sharedPaths"'))).toBe(false);
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
