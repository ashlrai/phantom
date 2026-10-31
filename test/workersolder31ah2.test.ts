import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

const fake = vi.hoisted(() => ({ table: '', fail: false, throws: false, reads: 0 }));
vi.mock('../src/core/fleet/runs-live-workers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/runs-live-workers.js')>();
  return { ...actual, listLiveWorkers: () => {
    fake.reads++;
    if (fake.throws) throw new Error('private failure');
    return actual.listLiveWorkers({ now: () => 0, runPs: async () => {
      if (fake.fail) throw new Error('private failure');
      return fake.table;
    } });
  } };
});

const table = [
  '101 00:09 /fake/bin/launch.sh YOUNG repo alpha work',
  '102 00:10 /fake/bin/launch.sh BOUNDARY repo alpha work',
  '103 00:11 /fake/bin/launch.sh OLD repo alpha work',
  '104 unknown /fake/bin/launch.sh UNKNOWN repo alpha work',
  '105 unknown /fake/bin/launch.sh OTHER-LANE repo beta work',
  '106 00:20 /fake/bin/launch.sh OTHER-REPO other alpha work',
  '107 00:01 /fake/bin/orch-pass.sh leader',
  '108 00:01 codex exec',
].join('\n');

describe('fleet workers age filtering', () => {
  let output: string[];
  let errors: string[];
  beforeEach(() => {
    fake.table = table; fake.fail = false; fake.throws = false; fake.reads = 0;
    output = []; errors = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  });
  afterEach(() => vi.restoreAllMocks());

  it('intersects lane, repo and strict age cutoff through the public dispatcher', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await cmdFleet(['workers', '--older-than-seconds', '10', '--lane', 'alpha', '--repo', 'repo', '--json'])).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({
      v: 1, generatedAt: '1970-01-01T00:00:00.000Z', sourceState: 'healthy',
      workers: [{ pid: 103, job: 'OLD', repo: 'repo', lane: 'alpha', tier: 'work', ageSeconds: 11 }],
      leaders: [{ pid: 107, label: 'leader', ageSeconds: 1 }], orchestratorAgents: 1,
      workerFilter: { lane: 'alpha', repo: 'repo', olderThanSeconds: 10, unknownAgeCount: 1,
        global: ['sourceState', 'leaders', 'orchestratorAgents'] },
    });
    expect(fake.reads).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('accepts zero and the maximum safe integer and counts all unknown ages without lane/repo filters', async () => {
    expect(await cmdFleet(['workers', '--older-than-seconds', '0', '--json'])).toBe(0);
    let result = JSON.parse(output.pop()!);
    expect(result.workers.map((worker: { job: string }) => worker.job)).toEqual(['YOUNG', 'BOUNDARY', 'OLD', 'OTHER-REPO']);
    expect(result.workerFilter).toMatchObject({ olderThanSeconds: 0, unknownAgeCount: 2 });
    expect(await cmdFleet(['workers', '--older-than-seconds', '9007199254740991', '--json'])).toBe(0);
    result = JSON.parse(output.pop()!);
    expect(result.workers).toEqual([]);
    expect(result.workerFilter).toMatchObject({ olderThanSeconds: Number.MAX_SAFE_INTEGER, unknownAgeCount: 2 });
  });

  it('preserves unfiltered and existing lane-filter JSON contracts', async () => {
    expect(await cmdFleet(['workers', '--json'])).toBe(0);
    const unfiltered = JSON.parse(output.pop()!);
    expect(unfiltered.workers).toHaveLength(6);
    expect(unfiltered).not.toHaveProperty('workerFilter');
    expect(await cmdFleet(['workers', '--lane', 'beta', '--json'])).toBe(0);
    const filtered = JSON.parse(output.pop()!);
    expect(filtered.workers[0]).toMatchObject({ job: 'OTHER-LANE', ageSeconds: null });
    expect(filtered.workerFilter).toEqual({ lane: 'beta', repo: null, global: ['sourceState', 'leaders', 'orchestratorAgents'] });
  });

  it('reports the filter and unknown count in human output', async () => {
    expect(await cmdFleet(['workers', '--lane', 'alpha', '--repo', 'repo', '--older-than-seconds', '10'])).toBe(0);
    expect(output.join('\n')).toContain('older-than-seconds=10 unknown-ages=1');
    expect(output.join('\n')).toContain('OLD  alpha  repo  work  11s');
    expect(output.join('\n')).not.toContain('BOUNDARY');
    expect(output.join('\n')).toContain('Leaders (global): 1; orchestrator agents (global): 1');
  });

  it('marks an unavailable source and an unknowable unknown-age count without leaking errors', async () => {
    fake.fail = true;
    expect(await cmdFleet(['workers', '--older-than-seconds', '10', '--json'])).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ sourceState: 'unavailable', workers: [],
      workerFilter: { olderThanSeconds: 10, unknownAgeCount: null } });
    expect(output.join('')).not.toContain('private failure');
    output.length = 0;
    expect(await cmdFleet(['workers', '--older-than-seconds', '10'])).toBe(1);
    expect(output.join('')).toContain('unknown-ages=unavailable');
    expect(output.join('')).toContain('Live process listing unavailable.');
  });

  it('handles an unexpected source exception without printing non-JSON stdout', async () => {
    fake.throws = true;
    expect(await cmdFleet(['workers', '--older-than-seconds', '10', '--json'])).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join('')).toBe('error: fleet workers unavailable\n');
  });

  it.each([
    [], ['-1'], ['+1'], ['1.0'], ['1e2'], ['NaN'], ['Infinity'], ['9007199254740992'],
    ['--json'], [' 1'], ['1 '], ['1', '--older-than-seconds', '2'],
  ])('rejects invalid age arguments %j before reading processes', async (...value) => {
    expect(await cmdFleet(['workers', '--older-than-seconds', ...value])).toBe(2);
    expect(fake.reads).toBe(0);
    expect(output).toEqual([]);
    expect(errors.join('')).toContain('invalid fleet workers arguments');
  });

  it('explains the cutoff, unknown ages and global totals in help without reading processes', async () => {
    expect(await cmdFleet(['workers', '--help'])).toBe(0);
    expect(output.join('')).toContain('--older-than-seconds N');
    expect(output.join('')).toContain('nonnegative safe integer');
    expect(output.join('')).toContain('strictly greater than N');
    expect(output.join('')).toContain('Unknown ages do not match');
    expect(output.join('')).toContain('null when the source is unavailable');
    expect(output.join('')).toContain('leaders and orchestrator agents remain global');
    expect(fake.reads).toBe(0);
  });
});
