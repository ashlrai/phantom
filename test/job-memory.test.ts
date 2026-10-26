import { describe, expect, it } from 'vitest';
import { JOB_MEMORY_LIMITS, memoryBoundedWorkers, boundedVitestJob, memoryJobEnv, collectJobMemory } from '../src/core/run/tool-path.js';

const MiB = 1024 * 1024;

describe('class-labelled memory receipts', () => {
  const receipt = (pid: number, rss: number, jobClass = 'test') => '[job-memory] ' + JSON.stringify({
    schema: 'phantom-job-memory/v1', jobClass, pid, peakRssKiB: rss,
  }) + '\n';

  it('preserves command output and reports the largest process peak, never a sum', () => {
    const result = collectJobMemory('command output\n' + receipt(1, 100) + receipt(2, 200) + receipt(1, 150), 'test');
    expect(result.output).toBe('command output\n');
    expect(result.memoryUsage).toEqual({ jobClass: 'test', peakRssKiB: 200,
      processes: [{ pid: 1, peakRssKiB: 150 }, { pid: 2, peakRssKiB: 200 }] });
  });

  it('retains malformed/foreign records as command output and leaves missing evidence unknown', () => {
    const text = '[job-memory] not-json\n' + receipt(1, 100, 'build') + receipt(2, -1);
    expect(collectJobMemory(text, 'test')).toEqual({ output: text,
      memoryUsage: { jobClass: 'test', peakRssKiB: null, processes: [] } });
  });

  it('bounds the receipt inventory', () => {
    const result = collectJobMemory(Array.from({ length: 200 }, (_, i) => receipt(i + 1, i + 100)).join(''), 'test');
    expect(result.memoryUsage.processes).toHaveLength(128);
    expect(result.memoryUsage.peakRssKiB).toBe(299);
    expect(result.output).toBe('');
  });

  it('preserves output that has no trailing newline', () => {
    const result = collectJobMemory('message' + receipt(1, 100), 'test');
    expect(result.output).toBe('message');
    expect(result.memoryUsage.peakRssKiB).toBe(100);
  });
});

describe('verification memory policy', () => {
  it('assigns every existing verification class a frozen, explicit heap cap', () => {
    expect(JOB_MEMORY_LIMITS).toEqual({
      typecheck: { maxOldSpaceMiB: 4096 }, lint: { maxOldSpaceMiB: 2048 },
      build: { maxOldSpaceMiB: 4096 }, test: { maxOldSpaceMiB: 1024 },
    });
    expect(Object.isFrozen(JOB_MEMORY_LIMITS)).toBe(true);
    for (const budget of Object.values(JOB_MEMORY_LIMITS)) expect(Object.isFrozen(budget)).toBe(true);
  });

  it.each([
    [0, 16, 1], [512, 16, 1], [3071, 16, 1], [3072, 16, 2],
    [4351, 16, 2], [4352, 16, 3], [5632, 16, 4], [65536, 16, 4],
    [65536, 2, 2], [65536, 2.9, 2], [65536, 1, 1],
  ])('bounds workers for %s MiB and %s CPUs to %s', (freeMiB, cpus, expected) => {
    expect(memoryBoundedWorkers(freeMiB * MiB, cpus)).toBe(expected);
  });

  it.each([NaN, Infinity, -Infinity, -1])('uses one worker for unknown memory (%s)', (free) => {
    expect(memoryBoundedWorkers(free, 16)).toBe(1);
  });
  it.each([NaN, Infinity, -Infinity, 0, -1])('uses one worker for invalid CPUs (%s)', (cpus) => {
    expect(memoryBoundedWorkers(65536 * MiB, cpus)).toBe(1);
  });

  it('replaces inherited heap/preload options without mutating the caller', () => {
    const base = { NODE_OPTIONS: '--require=untrusted --max-old-space-size=99999', node_options: 'untrusted',
      npm_config_node_options: '--require=untrusted', HOME: '/fixture' };
    const env = memoryJobEnv(base, 'typecheck');
    expect(env.NODE_OPTIONS).toMatch(/^--max-old-space-size=4096 --import=data:text\/javascript,/);
    expect(env.NODE_OPTIONS).not.toContain('untrusted');
    expect(env).not.toHaveProperty('node_options');
    expect(env).not.toHaveProperty('npm_config_node_options');
    expect(env.HOME).toBe('/fixture');
    expect(base.node_options).toBe('untrusted');
  });
});

describe('bounded Vitest job', () => {
  it('places enforced options before -- and leaves trailing filters untouched', () => {
    const job = boundedVitestJob({}, ['--', '--maxWorkers=99', 'test/example.test.ts'], 0, 8);
    expect(job.args).toEqual(['--no-file-parallelism', '--pool=forks', '--maxWorkers=1',
      '--', '--maxWorkers=99', 'test/example.test.ts']);
  });

  it('caps unit workers and selects forks without serializing a healthy budget', () => {
    const job = boundedVitestJob({}, ['test/example.test.ts', '--pool=threads', '--maxWorkers=20'], 5632 * MiB, 16);
    expect(job.args).toEqual(['test/example.test.ts', '--pool=forks', '--maxWorkers=4']);
    expect(job.env.ASHLR_VITEST_UNIT_MAX_WORKERS).toBe('4');
    expect(job.env.NODE_OPTIONS).toContain('--max-old-space-size=1024');
  });

  it('uses the lower of memory, CPU, existing unit and explicit CLI caps', () => {
    const job = boundedVitestJob({ ASHLR_VITEST_UNIT_MAX_WORKERS: '2' },
      ['--pool', 'threads', '--maxWorkers', '3'], 4352 * MiB, 4);
    expect(job.maxWorkers).toBe(3);
    expect(job.args).toEqual(['--pool=forks', '--maxWorkers=3']);
    expect(job.env.ASHLR_VITEST_UNIT_MAX_WORKERS).toBe('2');
  });

  it('preserves one unit worker with two global workers in an exhaustive shard', () => {
    const job = boundedVitestJob({ ASHLR_VITEST_UNIT_MAX_WORKERS: '1' }, ['--maxWorkers=2'], 65536 * MiB, 16);
    expect(job.args).toEqual(['--pool=forks', '--maxWorkers=2']);
    expect(job.env.ASHLR_VITEST_UNIT_MAX_WORKERS).toBe('1');
  });

  it('preserves an explicit fileParallelism=false argument', () => {
    const job = boundedVitestJob({}, ['--maxWorkers=1', '--fileParallelism=false'], 65536 * MiB, 16);
    expect(job.args).toEqual(['--fileParallelism=false', '--pool=forks', '--maxWorkers=1']);
  });

  it.each([['--max-workers=1'], ['--max-workers', '1']])('honors the kebab worker alias (%s)', (...args) => {
    const job = boundedVitestJob({}, args, 65536 * MiB, 16);
    expect(job.args).toEqual(['--no-file-parallelism', '--pool=forks', '--maxWorkers=1']);
  });

  it.each([['--file-parallelism=false'], ['--file-parallelism', 'false']])('normalizes kebab false (%s)', (...args) => {
    const job = boundedVitestJob({}, args, 0, 16);
    expect(job.args).toEqual(['--no-file-parallelism', '--pool=forks', '--maxWorkers=1']);
  });

  it.each(['1', '1%'])('retains a stricter %s CLI cap and serializes both inline lanes', (cap) => {
    const job = boundedVitestJob({}, [`--maxWorkers=${cap}`, '--fileParallelism=true'], 65536 * MiB, 8);
    expect(job.maxWorkers).toBe(1);
    expect(job.args).toEqual(['--no-file-parallelism', '--pool=forks', '--maxWorkers=1']);
  });

  it('forces file serialization when memory cannot admit two real-I/O workers', () => {
    const job = boundedVitestJob({}, ['--fileParallelism', 'true', '--no-file-parallelism', '--shard=2/3'], 3072 * MiB - 1, 16);
    expect(job.args).toEqual(['--no-file-parallelism', '--shard=2/3', '--pool=forks', '--maxWorkers=1']);
    expect(job.env.ASHLR_VITEST_UNIT_MAX_WORKERS).toBe('1');
  });

  it.each(['0', '-2', 'NaN', 'Infinity', '0%', '101%', 'nope'])('refuses malformed worker caps (%s)', (value) => {
    expect(() => boundedVitestJob({}, [`--maxWorkers=${value}`], 65536 * MiB, 8)).toThrow('maxWorkers');
  });

  it.each([['--pool'], ['--pool='], ['--pool', '--shard=1/2']])('refuses a missing pool value (%s)', (...args) => {
    expect(() => boundedVitestJob({}, args, 65536 * MiB, 8)).toThrow('pool requires a value');
  });
});
