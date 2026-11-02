import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

const fake = vi.hoisted(() => ({ table: '', fail: false, reads: 0 }));
vi.mock('../src/core/fleet/runs-live-workers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/runs-live-workers.js')>();
  return { ...actual, listLiveWorkers: () => actual.listLiveWorkers({
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    runPs: async () => {
      fake.reads++;
      if (fake.fail) throw new Error('/fake/private-command');
      return fake.table;
    },
  }) };
});

const table = [
  '101 00:42 /fake/private/bin/launch.sh FAKE-JOB-1 fake-repo alpha work --fake-private-argument',
  '102 unknown /fake/private/bin/launch.sh FAKE-JOB-2 fake-repo beta fast',
  '103 00:12 /fake/private/bin/launch.sh FAKE-JOB-3 other-repo alpha frontier',
  '104 00:10 /fake/private/bin/orch-pass.sh fake-pass',
  '105 00:09 codex exec --fake-private-argument',
].join('\n');

describe('fleet workers CLI', () => {
  let output: string[];
  let errors: string[];
  beforeEach(() => {
    fake.table = table; fake.fail = false; fake.reads = 0;
    output = []; errors = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('dispatches to the canonical reader and intersects filters while retaining global data', async () => {
    expect(await cmdFleet(['workers', '--lane', 'alpha', '--repo', 'fake-repo', '--json'])).toBe(0);
    expect(fake.reads).toBe(1);
    const result = JSON.parse(output.join(''));
    expect(result).toEqual({
      v: 1, generatedAt: '2026-01-01T00:00:00.000Z', sourceState: 'healthy',
      workers: [{ pid: 101, job: 'FAKE-JOB-1', repo: 'fake-repo', lane: 'alpha', tier: 'work', ageSeconds: 42 }],
      leaders: [{ pid: 104, label: 'fake-pass', ageSeconds: 10 }], orchestratorAgents: 1,
      workerFilter: { lane: 'alpha', repo: 'fake-repo', global: ['sourceState', 'leaders', 'orchestratorAgents'] },
    });
    expect(output.join('')).not.toMatch(/\/fake\/private|launch\.sh|fake-private-argument|codex exec/);
  });

  it('prints filtered rows and unknown age without process commands or paths', async () => {
    expect(await cmdFleet(['workers', '--lane', 'beta'])).toBe(0);
    expect(output.join('\n')).toContain('Worker rows filtered: lane=beta repo=any');
    expect(output.join('\n')).toContain('FAKE-JOB-2  beta  fake-repo  fast  unknown');
    expect(output.join('\n')).toContain('Leaders (global): 1; orchestrator agents (global): 1');
    expect(output.join('\n')).not.toMatch(/FAKE-JOB-1|\/fake\/private|launch\.sh|fake-private-argument/);
  });

  it('distinguishes a healthy empty table from an unavailable process read', async () => {
    fake.table = '';
    expect(await cmdFleet(['workers'])).toBe(0);
    expect(output.join('\n')).toContain('No live workers.');
    output.length = 0;
    fake.fail = true;
    expect(await cmdFleet(['workers', '--json'])).toBe(1);
    expect(JSON.parse(output.join(''))).toMatchObject({ sourceState: 'unavailable', workers: [] });
    expect(output.join('')).not.toContain('/fake/private-command');
    output.length = 0;
    expect(await cmdFleet(['workers'])).toBe(1);
    expect(output.join('')).toContain('Live process listing unavailable.');
    expect(output.join('')).not.toContain('No live workers.');
  });

  it('identifies an empty filtered result without implying the whole fleet is empty', async () => {
    expect(await cmdFleet(['workers', '--repo', 'missing-repo'])).toBe(0);
    expect(output.join('')).toContain('No matching live workers.');
  });

  it.each([
    ['--bogus'], ['--lane'], ['--lane', '--json'], ['--repo', '../fake'],
    ['--lane', 'BAD'], ['--repo', 'fake', '--repo', 'other'], ['unexpected'], ['--json', '--json'],
  ])('rejects invalid arguments %j before reading processes', async (...args) => {
    expect(await cmdFleet(['workers', ...args])).toBe(2);
    expect(fake.reads).toBe(0);
    expect(errors.join('')).toContain('invalid fleet workers arguments');
  });

  it('shows help without reading processes', async () => {
    expect(await cmdFleet(['workers', '--help'])).toBe(0);
    expect(output.join('')).toContain('Filters apply to worker rows');
    expect(fake.reads).toBe(0);
  });
});
