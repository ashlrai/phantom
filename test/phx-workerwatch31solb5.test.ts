import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import '../src/cli/fleet-workers.js';

const fake = vi.hoisted(() => ({
  responses: [] as Array<string | Error>, reads: 0, pending: false,
}));
vi.mock('../src/core/fleet/runs-live-workers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/runs-live-workers.js')>();
  return { ...actual, listLiveWorkers: () => {
    fake.reads++;
    if (fake.pending) return new Promise<never>(() => {});
    const response = fake.responses.shift() ?? '';
    if (response instanceof Error && response.message === 'throw-reader') throw new Error('/fake/private-reader-error');
    return actual.listLiveWorkers({ now: () => fake.reads * 1000, runPs: async () => {
      if (response instanceof Error) throw response;
      return response;
    } });
  } };
});

const table = (age: string) => [
  `101 ${age} /fake/bin/launch.sh JOB repo alpha work --private-argument`,
  '102 unknown /fake/bin/launch.sh UNKNOWN repo alpha work',
  '103 00:30 /fake/bin/launch.sh OTHER other beta work',
  '104 00:01 /fake/bin/orch-pass.sh leader',
  '105 00:01 codex exec --private-argument',
].join('\n');

describe('fleet workers watch', () => {
  let output: string[];
  let errors: string[];
  beforeEach(() => {
    fake.responses = []; fake.reads = 0; fake.pending = false;
    output = []; errors = [];
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('reapplies filters as workers age, appear and disappear, preserving global data', async () => {
    const global = '104 00:01 /fake/bin/orch-pass.sh leader\n105 00:01 codex exec';
    fake.responses = [global, table('00:10'), table('00:11'), global];
    const run = cmdFleet(['workers', '--watch', '--interval-ms', '1000', '--max-samples', '4',
      '--lane', 'alpha', '--repo', 'repo', '--older-than-seconds', '10', '--json']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await run).toBe(0);
    expect(fake.reads).toBe(4);
    const results = output.map(line => JSON.parse(line));
    expect(results.map(result => result.workers.map((worker: { job: string }) => worker.job))).toEqual([[], [], ['JOB'], []]);
    expect(results.map(result => result.workerFilter.unknownAgeCount)).toEqual([0, 1, 1, 0]);
    expect(results.every(result => result.sourceState === 'healthy' && result.leaders.length === 1 && result.orchestratorAgents === 1)).toBe(true);
    expect(output.join('')).not.toMatch(/\/fake\/|private-argument|launch\.sh|codex exec/);
    expect(errors).toEqual([]);
  });

  it('counts only healthy samples and resets consecutive errors after recovery', async () => {
    fake.responses = [new Error('/fake/private'), new Error('throw-reader'), table('00:11'),
      new Error('/fake/private'), new Error('/fake/private'), table('00:12')];
    const run = cmdFleet(['workers', '--watch', '--max-samples', '2', '--json']);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await run).toBe(0);
    expect(fake.reads).toBe(6);
    const results = output.map(line => JSON.parse(line));
    expect(results.filter(result => result.error)).toEqual(Array(4).fill({ v: 1, error: 'fleet workers unavailable', sourceState: 'unavailable' }));
    expect(results.filter(result => result.workers)).toHaveLength(2);
    expect(output.join('')).not.toContain('/fake/private');
  });

  it('stops after three consecutive failures with a stable error envelope', async () => {
    fake.responses = Array(3).fill(new Error('/fake/private'));
    const run = cmdFleet(['workers', '--watch', '--max-samples', '1', '--json']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await run).toBe(1);
    expect(fake.reads).toBe(3);
    expect(output.map(line => JSON.parse(line))).toEqual(Array(3).fill({ v: 1, error: 'fleet workers unavailable', sourceState: 'unavailable' }));
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('aborts a pending read on %s and removes signal listeners', async signal => {
    fake.pending = true;
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const run = cmdFleet(['workers', '--watch', '--json']);
    await vi.advanceTimersByTimeAsync(0);
    const before = signal === 'SIGINT' ? beforeInt : beforeTerm;
    const added = process.listeners(signal).filter(listener => !before.includes(listener));
    expect(added).toHaveLength(1);
    added[0]!();
    expect(await run).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
    expect(fake.reads).toBe(1);
    expect(output).toEqual([]);
  });

  it('aborts the interval without another read', async () => {
    fake.responses = [table('00:11')];
    const before = process.listeners('SIGINT');
    const run = cmdFleet(['workers', '--watch']);
    await vi.advanceTimersByTimeAsync(0);
    process.listeners('SIGINT').find(listener => !before.includes(listener))!();
    expect(await run).toBe(130);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fake.reads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['--interval-ms', '1000'], ['--max-samples', '1'],
    ['--watch', '--interval-ms', '999'], ['--watch', '--interval-ms', '60001'],
    ['--watch', '--interval-ms', '1.0'], ['--watch', '--interval-ms'],
    ['--watch', '--max-samples', '0'], ['--watch', '--max-samples', '10001'],
    ['--watch', '--max-samples', '1', '--max-samples', '2'], ['--watch', '--watch'],
  ])('rejects invalid arguments %j without reading', async (...args) => {
    expect(await cmdFleet(['workers', ...args])).toBe(2);
    expect(fake.reads).toBe(0);
    expect(errors.join('')).toContain('invalid fleet workers arguments');
  });

  it('accepts boundary values and stops after one sample', async () => {
    fake.responses = [''];
    expect(await cmdFleet(['workers', '--watch', '--interval-ms', '60000', '--max-samples', '1', '--json'])).toBe(0);
    expect(fake.reads).toBe(1);
    expect(JSON.parse(output[0]!).sourceState).toBe('healthy');
  });
});
