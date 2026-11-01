import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

const fake = vi.hoisted(() => ({ table: '', fail: false, reads: 0 }));
vi.mock('../src/core/fleet/runs-live-workers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/runs-live-workers.js')>();
  return { ...actual, listLiveWorkers: () => actual.listLiveWorkers({
    now: () => 0,
    runPs: async () => {
      fake.reads++;
      if (fake.fail) throw new Error('private failure');
      return fake.table;
    },
  }) };
});

const table = [
  '101 00:20 /fake/bin/launch.sh JOB-1 phantom personal work',
  '102 00:10 /fake/bin/launch.sh JOB-2 phantom devin fast',
  '103 unknown /fake/bin/launch.sh JOB-3 other personal frontier',
  '104 00:09 /fake/bin/launch.sh JOB-1 phantom personal work',
  '105 00:05 /fake/bin/orch-pass.sh leader',
  '106 00:04 codex exec --private',
].join('\n');

describe('fleet workers minimum expectation', () => {
  let output: string[];
  let errors: string[];
  beforeEach(() => {
    fake.table = table; fake.fail = false; fake.reads = 0;
    output = []; errors = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('ignores queued work when the process table contains no live workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-expect-'));
    try {
      mkdirSync(join(root, 'queue'));
      writeFileSync(join(root, 'queue', 'queued.json'), JSON.stringify({ id: 'JOB-QUEUED', status: 'queued' }));
      vi.stubEnv('ASHLR_HOME', root);
      fake.table = '105 00:05 /fake/bin/orch-pass.sh leader';
      expect(await cmdFleet(['workers', '--json', '--expect-min', '1'])).toBe(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ workers: [], leaders: [{ pid: 105 }],
        expectMinCheck: { v: 1, expected: 1, observed: 0, passed: false, sourceState: 'healthy' } });
      expect(fake.reads).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('passes at the threshold, fails above it, and retains the complete snapshot', async () => {
    expect(await cmdFleet(['workers', '--json'])).toBe(0);
    const snapshot = JSON.parse(output.pop()!);
    expect(await cmdFleet(['workers', '--expect-min', '3', '--json'])).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual({ ...snapshot,
      expectMinCheck: { v: 1, expected: 3, observed: 3, passed: true, sourceState: 'healthy' } });
    expect(await cmdFleet(['workers', '--json', '--expect-min', '4'])).toBe(1);
    expect(JSON.parse(output.pop()!)).toEqual({ ...snapshot,
      expectMinCheck: { v: 1, expected: 4, observed: 3, passed: false, sourceState: 'healthy' } });
    expect(fake.reads).toBe(3);
    expect(errors).toEqual([]);
  });

  it('checks the intersection of lane, repo and age filters while retaining global provenance', async () => {
    const args = ['workers', '--lane', 'personal', '--repo', 'phantom', '--older-than-seconds', '10', '--json'];
    expect(await cmdFleet(args)).toBe(0);
    const snapshot = JSON.parse(output.pop()!);
    expect(await cmdFleet([...args, '--expect-min', '1'])).toBe(0);
    const result = JSON.parse(output.pop()!);
    expect(result).toEqual({ ...snapshot,
      expectMinCheck: { v: 1, expected: 1, observed: 1, passed: true, sourceState: 'healthy' } });
    expect(result.workers.map((worker: { job: string }) => worker.job)).toEqual(['JOB-1']);
    expect(result.workerFilter).toEqual({ lane: 'personal', repo: 'phantom', olderThanSeconds: 10,
      unknownAgeCount: 0, global: ['sourceState', 'leaders', 'orchestratorAgents'] });
    expect(result.leaders).toHaveLength(1);
    expect(result.orchestratorAgents).toBe(1);
    expect(await cmdFleet(['workers', '--lane', 'devin', '--repo', 'phantom', '--json', '--expect-min', '2'])).toBe(1);
    expect(JSON.parse(output.pop()!).expectMinCheck.observed).toBe(1);
  });

  it('passes a healthy zero expectation and fails unknown observations even at zero', async () => {
    fake.table = '';
    expect(await cmdFleet(['workers', '--json', '--expect-min', '0'])).toBe(0);
    expect(JSON.parse(output.pop()!).expectMinCheck).toEqual({
      v: 1, expected: 0, observed: 0, passed: true, sourceState: 'healthy',
    });
    fake.fail = true;
    expect(await cmdFleet(['workers', '--lane', 'personal', '--json', '--expect-min', '0'])).toBe(1);
    const result = JSON.parse(output.pop()!);
    expect(result).toMatchObject({ sourceState: 'unavailable', workers: [],
      workerFilter: { lane: 'personal', global: ['sourceState', 'leaders', 'orchestratorAgents'] },
      expectMinCheck: { v: 1, expected: 0, observed: null, passed: false, sourceState: 'unavailable' } });
    expect(JSON.stringify(result)).not.toContain('private failure');
  });

  it('accepts the maximum safe integer', async () => {
    expect(await cmdFleet(['workers', '--json', '--expect-min', '9007199254740991'])).toBe(1);
    expect(JSON.parse(output[0]!).expectMinCheck.expected).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['--expect-min'], ['--expect-min', '--json'], ['--expect-min', '1'],
    ...['-1', '+1', '1.0', '1e2', 'NaN', 'Infinity', '9007199254740992', ' 1', '1 ']
      .map(value => ['--json', '--expect-min', value]),
    ['--json', '--expect-min', '1', '--expect-min', '2'],
  ])('rejects invalid arguments %j before reading processes', async (...args) => {
    expect(await cmdFleet(['workers', ...args])).toBe(2);
    expect(fake.reads).toBe(0);
    expect(output).toEqual([]);
    expect(errors.join('')).toContain('error:');
  });

  it('documents the check in command help', async () => {
    expect(await cmdFleet(['workers', '--help'])).toBe(0);
    expect(output.join('')).toContain('--expect-min N');
    expect(output.join('')).toContain('requires --json');
    expect(fake.reads).toBe(0);
  });
});
