import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobDetail, type FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';

let runs: string;
let logs: string[];
let stdout: string;
let stderr: string;

const clock = () => new Date('2026-10-31T01:02:03.000Z');

function detailOf(state: FleetJobDetailV1['state'], tail: string[]): FleetJobDetailV1 {
  const live = state === 'running';
  return {
    schema: 'fleet.job.v1',
    generatedAt: clock().toISOString(),
    job: 'JOB9',
    state,
    lane: 'main', tier: 'work', model: 'fake-model',
    pid: live ? 4242 : null,
    launchedAt: live ? '2026-10-31T00:00:00.000Z' : null,
    baseSha: 'abc1234', branch: 'fake-branch', promptBytes: 42,
    publish: state === 'published'
      ? { prUrl: 'https://example.invalid/pr/9', autoMerge: true, testLine: 'TEST fake exit 0', sensitive: [] }
      : null,
    notes: { hasNotes: false, hasBody: false, notesBytes: null },
    log: { source: live || state === 'published' ? 'live' : state === 'archived' ? 'archived' : 'missing', bytes: 120, tail, truncated: false },
    sources: {
      launch: live ? 'healthy' : 'missing', base: 'missing', meta: 'missing',
      publish: state === 'published' ? 'healthy' : 'missing', log: live || state === 'published' ? 'healthy' : 'missing',
    },
  };
}

beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), 'fleet-job-watch-'));
  logs = []; stdout = ''; stderr = '';
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runs, { recursive: true, force: true });
});

function setup(detail: typeof getFleetJobDetail) {
  const output = {
    log: vi.fn((text: string) => { logs.push(text); }),
    stdout: vi.fn((text: string) => { stdout += text; }),
    stderr: vi.fn((text: string) => { stderr += text; }),
  };
  return { deps: { detail, changes: getFleetJobChanges, output }, output };
}

const sequence = (jobs: FleetJobDetailV1[]) => {
  const detail = vi.fn(async () => jobs.shift() ?? detailOf('published', []));
  return detail;
};

describe('fleet job --watch', () => {
  it('follows a worker through new tail lines until it publishes, exit 0 with the stop reason', async () => {
    const detail = sequence([
      detailOf('running', ['line one', 'line two']),
      detailOf('running', ['line two', 'line three', 'line four']),
      detailOf('published', ['line two', 'line three', 'line four', 'shipped it']),
    ]);
    const wait = vi.fn(async () => {});
    const { deps } = setup(detail);
    expect(await cmdFleetJobRead(['JOB9', '--watch', '--interval-ms', '1000'], deps, { wait })).toBe(0);
    expect(detail).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenLastCalledWith(1000, expect.any(AbortSignal));
    expect(logs).toHaveLength(4); // three snapshots plus the stop line
    expect(logs[0]).toContain(`--- ${clock().toISOString()} snapshot 1 ---`);
    expect(logs[0]).toContain('line one\nline two');
    expect(logs[1]).toContain('snapshot 2');
    expect(logs[1]).toContain('line three\nline four');
    expect(logs[1]).not.toContain('line one');
    expect(logs[1]).not.toContain('line two');
    expect(logs[2]).toContain('snapshot 3');
    expect(logs[2]).toContain('shipped it');
    expect(logs[2]).not.toContain('line two');
    expect(logs[3]).toBe('watch stopped: job JOB9 published; PR https://example.invalid/pr/9');
  });

  it('streams only newly appended lines in --log watch mode', async () => {
    const detail = sequence([
      detailOf('running', ['a', 'b']),
      detailOf('running', ['b', 'c']),
      detailOf('published', ['b', 'c', 'd']),
    ]);
    const { deps } = setup(detail);
    expect(await cmdFleetJobRead(['JOB9', '--log', '--watch'], deps, { wait: async () => {} })).toBe(0);
    expect(stdout).toBe(
      `--- ${clock().toISOString()} snapshot 1 ---\na\nb\n` +
      `--- ${clock().toISOString()} snapshot 2 ---\nc\n` +
      `--- ${clock().toISOString()} snapshot 3 ---\nd\n`,
    );
    expect(stderr).toContain('Log: live; health: healthy; truncated: no');
    expect(logs.join('\n')).toContain('watch stopped: job JOB9 published');
  });

  it('emits fleet.job.error.v1 on failures and keeps watching in --json mode', async () => {
    let calls = 0;
    const detail = vi.fn(async () => {
      if (++calls <= 2) throw new Error('fake private reason');
      return detailOf('published', ['done']);
    });
    const { deps } = setup(detail);
    expect(await cmdFleetJobRead(['JOB9', '--watch', '--json'], deps, { wait: async () => {} })).toBe(0);
    expect(logs).toHaveLength(4);
    const errors = logs.slice(0, 2).map(line => JSON.parse(line));
    expect(errors).toEqual([
      { schema: 'fleet.job.error.v1', job: 'JOB9', at: expect.any(String), error: 'fake private reason' },
      { schema: 'fleet.job.error.v1', job: 'JOB9', at: expect.any(String), error: 'fake private reason' },
    ]);
    expect(JSON.parse(logs[2]!)).toMatchObject({ schema: 'fleet.job.v1', job: 'JOB9', state: 'published' });
    expect(JSON.parse(logs[3]!)).toMatchObject({ schema: 'fleet.job.watch.stop.v1', job: 'JOB9', snapshots: 1, reason: expect.stringContaining('published') });
  });

  it('exits 1 after five consecutive read failures', async () => {
    const detail = vi.fn(async () => { throw new Error('down'); });
    const { deps } = setup(detail);
    expect(await cmdFleetJobRead(['JOB9', '--watch', '--json'], deps, { wait: async () => {} })).toBe(1);
    expect(detail).toHaveBeenCalledTimes(5);
    expect(logs.filter(line => line.includes('fleet.job.error.v1'))).toHaveLength(5);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ schema: 'fleet.job.watch.stop.v1', reason: '5 consecutive read failures' });
  });

  it('stops on an archived end state and on three snapshots with no live evidence', async () => {
    const { deps } = setup(sequence([detailOf('running', ['x']), detailOf('archived', ['x'])]));
    expect(await cmdFleetJobRead(['JOB9', '--watch'], deps, { wait: async () => {} })).toBe(0);
    expect(logs.at(-1)).toContain('watch stopped: job JOB9 ended without publish evidence');
    logs = [];
    const dead = vi.fn(async () => detailOf('unknown', []));
    const { deps: deadDeps } = setup(dead);
    expect(await cmdFleetJobRead(['JOB9', '--watch'], deadDeps, { wait: async () => {} })).toBe(0);
    expect(dead).toHaveBeenCalledTimes(3);
    expect(logs.at(-1)).toBe('watch stopped: no live evidence for 3 consecutive snapshots');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops on %s and removes both process listeners', async signal => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const { deps } = setup(vi.fn(async () => detailOf('running', ['working'])));
    const result = cmdFleetJobRead(['JOB9', '--watch'], deps, {
      wait: async () => { process.emit(signal); },
    });
    expect(await result).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(logs.at(-1)).toBe('watch stopped: interrupted');
  });

  it('interrupts the default wait when the injected signal aborts', async () => {
    const controller = new AbortController();
    const detail = vi.fn(async () => {
      const job = detailOf('running', []);
      setTimeout(() => controller.abort(), 10);
      return job;
    });
    const { deps } = setup(detail);
    expect(await cmdFleetJobRead(['JOB9', '--watch', '--interval-ms', '60000'], deps, { signal: controller.signal })).toBe(0);
    expect(detail).toHaveBeenCalledTimes(1);
  }, 5000);

  it('follows real runs-dir artifacts until a publish lands', async () => {
    await writeFile(join(runs, 'JOB1.launch'), 'launched JOB1 main pid 99 base abc1234\n');
    await writeFile(join(runs, 'JOB1.log'), 'started\n');
    const detail = (id: string) => getFleetJobDetail(id, { runsDir: runs });
    const { deps } = setup(detail);
    let waits = 0;
    const wait = async () => {
      if (++waits === 1) await writeFile(join(runs, 'JOB1.log'), 'started\nprogress\n');
      else await writeFile(join(runs, 'JOB1.publish'), 'RESULT PR https://example.invalid/9\nTEST fake exit 0\n');
    };
    expect(await cmdFleetJobRead(['JOB1', '--log', '--watch', '--interval-ms', '1000'], deps, { wait })).toBe(0);
    expect(stdout.match(/--- .+ snapshot \d+ ---\n/g)).toHaveLength(3);
    expect(stdout).toContain('snapshot 1 ---\nstarted\n');
    expect(stdout).toContain('snapshot 2 ---\nprogress\n');
    expect(logs.at(-1)).toContain('watch stopped: job JOB1 published; PR https://example.invalid/9');
  });

  it('rejects bad intervals and forbidden watch combinations before any read', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const changes = vi.fn<typeof getFleetJobChanges>();
    const output = { log: vi.fn(), stdout: vi.fn(), stderr: vi.fn() };
    for (const args of [
      ['JOB9', '--interval-ms', '1000'],
      ['JOB9', '--watch', '--interval-ms'],
      ['JOB9', '--watch', '--interval-ms', '999'],
      ['JOB9', '--watch', '--interval-ms', '60001'],
      ['JOB9', '--watch', '--interval-ms', 'abc'],
      ['JOB9', '--watch', '--interval-ms', '1000', '--interval-ms', '2000'],
      ['JOB9', '--watch', '--watch'],
      ['JOB9', '--watch', '--changes'],
      ['JOB9', '--watch', '--prompt'],
      ['JOB9', '--watch', '--notes'],
      ['JOB9', '--watch', '--require-published', '--json'],
      ['--help', '--interval-ms', '1000'],
    ]) {
      expect(await cmdFleetJobRead(args, { detail, changes, output }), args.join(' ')).toBe(2);
    }
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledWith(expect.stringContaining('invalid fleet job arguments'));
  });

  it('accepts the interval bounds and stops a pre-aborted watch without reading', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const { deps } = setup(detail);
    for (const ms of ['1000', '60000']) {
      logs = [];
      expect(await cmdFleetJobRead(['JOB9', '--watch', '--interval-ms', ms], deps, { signal: AbortSignal.abort() })).toBe(0);
      expect(logs).toEqual(['watch stopped: interrupted']);
    }
    expect(detail).not.toHaveBeenCalled();
  });
});
