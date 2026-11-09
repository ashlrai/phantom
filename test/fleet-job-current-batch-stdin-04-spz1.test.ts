import { Readable } from 'node:stream';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobCurrentBatch, JOB_STDIN_MAX_BYTES, type JobIdStdin } from '../src/cli/fleet-job-current-batch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pipe = (...chunks: Array<string | Buffer>): JobIdStdin => Readable.from(
  chunks.map(chunk => typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk),
);

function endless(state: { pulled: number; closed: boolean }): JobIdStdin {
  return (async function* () {
    try {
      for (;;) { state.pulled++; yield Buffer.alloc(1024, 0x20); }
    } finally { state.closed = true; }
  })();
}

// ---------------------------------------------------------------------------
// Validation tests (fast — no git calls; any directory is fine)
// ---------------------------------------------------------------------------

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Reject mixed source, repeated/unknown flags, empty, scalar, object, empty/oversized array */
it('rejects mixed input, duplicate flags, unknown options, duplicates, nonstrings, invalid ids  (exit 2)', async () => {
  const twentyOne = JSON.stringify(Array.from({ length: 21 }, (_, i) => `RQ-JOB-${i}`));
  const invalidIds = ['nope', 'rq-a', 'RQ-', 'RQ-A B', '["--json"]', '["RQ-AAA-1/../x"]'];
  const cases: Array<string | string[]> = [
    // Mixed source
    ['RQ-A', '--stdin'], ['--stdin', 'RQ-A'], ['--stdin', 'RQ-A', '--json'],
    // Duplicate / unknown flags
    ['--stdin', '--stdin'], ['--stdin', '--json', '--json'],
    ['--stdin', '--bogus'], ['--stdin', '--limit', '0'], ['--stdin', '--limit'],
    ['--stdin', '-h'], ['--stdin', '--help'], ['--stdin', '--ref', 'HEAD'],
    // Scalar / object / empty / oversized
    '' as string, '   ', 'RQ-AAA-1', '{"ids":["RQ-AAA-1"]}', '"RQ-AAA-1"', '[]', twentyOne,
    '["RQ-AAA-1",]', '["RQ-AAA-1"] trailing', '["RQ-AAA-1"][0]',
    // Invalid id / type
    '[1]', '[null]', '[["RQ-AAA-1"]]', '[{"id":"RQ-AAA-1"}]', '[true]',
    ...invalidIds.map(id => JSON.stringify([id])),
    '["RQ-AAA-1","RQ-AAA-1"]',
  ];
  for (const args of cases) {
    if (typeof args === 'string') {
      expect(await cmdFleetJobCurrentBatch(['--stdin'], pipe(args))).toBe(2);
    } else {
      const state = { pulled: 0, closed: false };
      expect(await cmdFleetJobCurrentBatch(args, endless(state))).toBe(2);
      expect(state.pulled).toBe(0);
    }
  }
});

it('stops reading an oversized stream as soon as it passes 64 KiB', async () => {
  const state = { pulled: 0, closed: false };
  expect(await cmdFleetJobCurrentBatch(['--stdin'], endless(state))).toBe(2);
  expect(JOB_STDIN_MAX_BYTES).toBe(65536);
  expect(state.pulled).toBe(65);
  expect(state.closed).toBe(true);
});

it('accepts input of exactly 64 KiB and rejects one byte more', async () => {
  const body = JSON.stringify(['RQ-AAA-1']);
  const padded = (size: number) => body.slice(0, -1) + ' '.repeat(size - body.length) + ']';
  expect(await cmdFleetJobCurrentBatch(['--stdin'], pipe(padded(JOB_STDIN_MAX_BYTES)))).toBe(0);
  expect(await cmdFleetJobCurrentBatch(['--stdin'], pipe(padded(JOB_STDIN_MAX_BYTES + 1)))).toBe(2);
});

it('rejects invalid UTF-8 with usage 2', async () => {
  expect(await cmdFleetJobCurrentBatch(['--stdin'], pipe(Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d])))).toBe(2);
  expect(await cmdFleetJobCurrentBatch(['--stdin'], pipe(Buffer.from('["RQ-AAA-1\xc3"', 'latin1')))).toBe(2);
});

it('never echoes raw stdin content in errors', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetJobCurrentBatch(['--stdin'], pipe('["RQ-AAA-1", "SECRET-PROBE-771"]'))).toBe(2);
  expect(await cmdFleetJobCurrentBatch(['--stdin'], pipe('SECRET-PROBE-772 not json'))).toBe(2);
  const printed = error.mock.calls.map((call) => String(call[0])).join('\n');
  expect(printed).not.toContain('SECRET-PROBE-771');
  expect(printed).not.toContain('SECRET-PROBE-772');
});

// Stream error
it('returns a concise nonzero result on a stream error', async () => {
  const failing = (async function* () {
    yield Buffer.from('["RQ-AAA-1"', 'utf8');
    throw new Error('EIO: /private/fake/stdin-path');
  })();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetJobCurrentBatch(['--stdin', '--json'], failing)).toBe(1);
  expect(error).toHaveBeenCalledWith('error: unable to read job current batch from stdin');
  expect(log).not.toHaveBeenCalled();
  const printed = [...error.mock.calls, ...log.mock.calls].map(c => String(c[0])).join('\n');
  expect(printed).not.toContain('/private/fake');
  log.mockRestore();
  error.mockRestore();
});

// --help
it('--help and -h print usage without consuming stdin', async () => {
  for (const args of [['--help'], ['-h']]) {
    const state = { pulled: 0, closed: false };
    expect(await cmdFleetJobCurrentBatch(args, endless(state))).toBe(0);
    expect(state.pulled).toBe(0);
  }
});

// ===========================================================================
//  Integration: CLI routing of stdin through the existing pinned batch report
//  Uses real git from a temp repo, verifying output shape matches what
//  the core test (04-spx1) already proves correct.
// ===========================================================================

const execAsync = promisify(execFile);

it('integration: stdin on a real git repo produces a pinned batch report (absent-at-both + changed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-batch-stdin-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    const commit = (subject: string) => { git('add', '-A'); git('commit', '-qm', subject); };
    git('init', '-q'); git('config', 'user.name', 'Fake');
    git('config', 'user.email', 'fake@example.invalid');

    write('base.txt', 'base'); commit('plain base');
    write('keep.txt', 'keep'); write('edit.txt', 'v1'); write('gone.txt', 'bye');
    commit('bridge(RQ-BAT-1): first job secret words (#7)');
    const sha1 = git('rev-parse', 'HEAD').trim();

    write('two.txt', 'two'); commit('bridge(RQ-BAT-2): second job (#8)');
    const sha2 = git('rev-parse', 'HEAD').trim();

    write('edit.txt', 'v2'); rmSync(join(dir, 'gone.txt'));
    commit('plain later work');

    git('update-ref', 'refs/remotes/origin/master', 'HEAD');

    // Call the CLI with stdin, injecting a runner that operates on the temp dir.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const runner = async (args: string[]) => (await execAsync('git', args, {
      cwd: dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })).stdout;

    // We must pass runner through the CLI → core path.
    const code = await cmdFleetJobCurrentBatch(
      ['--stdin', '--json'], pipe(JSON.stringify(['RQ-BAT-1', 'RQ-BAT-2', 'RQ-NOPE-9'])), runner,
    );
    expect(code).toBe(0);

    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out).toMatchObject({ schemaVersion: 1, ref: 'origin/master' });
    expect(out.jobs.map((job: { jobId: string }) => job.jobId))
      .toEqual(['RQ-BAT-1', 'RQ-BAT-2', 'RQ-NOPE-9']);

    // RQ-BAT-1 and RQ-BAT-2 match bridge commits; RQ-NOPE-9 is absent-at-both.
    expect(out.jobs[0].commit).toMatchObject({ sha: sha1, pr: 7 });
    expect(out.jobs[0].entries).toHaveLength(3);
    expect(out.jobs[1].commit).toMatchObject({ sha: sha2, pr: 8 });
    expect(out.jobs[2].commit).toBeNull();
    expect(out.jobs[2].entries).toEqual([]);

    // Totals are consistent with the two-match result.
    expect(out.totals).toMatchObject({ jobs: 3, matched: 2, changed: 1, absentNow: 1 });

    // Secret phrase must never appear in the JSON output.
    expect(JSON.stringify(out)).not.toContain('secret words');

    // A job absent at the commit and absent at current = absent-at-both.
    expect(out.totals.absentAtBoth).toBe(0);

    log.mockRestore();
    error.mockRestore();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// CLI text-mode output via stdin (also with injected runner)
it('CLI output via --stdin preserves text format (not just JSON)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-text-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.name', 'Fake');
    git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'x.txt'), 'x');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = async (args: string[]) => (await execAsync('git', args, {
      cwd: dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })).stdout;

    const code = await cmdFleetJobCurrentBatch(
      ['--stdin'], pipe('["RQ-BBB-2", "RQ-NOPE-1"]'), runner,
    );
    expect(code).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('RQ-BBB-2') && line.includes('bridge commit'))).toBe(true);
    expect(lines.some(line => line.includes('does not prove the job never landed'))).toBe(true);
    expect(lines.at(-1)).toContain('evidence only');
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Positional compatibility (through the CLI)
it('keeps positional IDs working through the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-pos-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.name', 'Fake');
    git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'x.txt'), 'x');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = async (args: string[]) => (await execAsync('git', args, {
      cwd: dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })).stdout;

    expect(await cmdFleetJobCurrentBatch(['RQ-POS-1', '--json'], runner)).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out.jobs[0].jobId).toBe('RQ-POS-1');
    expect(out.jobs[0].commit).toBeNull();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
