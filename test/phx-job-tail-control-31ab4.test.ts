import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { getFleetJobDetail, type FleetJobDetailOptions } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

let runs: string;
const lines = Array.from({ length: 140 }, (_, i) => `line ${i + 1}`);
const clock = () => new Date('2026-10-30T23:51:00.000Z');

beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'fleet-tail-control-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runs, { recursive: true, force: true });
});

function setup() {
  const detail = vi.fn((id: string, options?: FleetJobDetailOptions) =>
    getFleetJobDetail(id, { ...options, runsDir: runs, now: clock }));
  const changes = vi.fn<typeof getFleetJobChanges>();
  const text = vi.fn<typeof getFleetJobText>();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { deps: { detail, changes, text }, detail, changes, text, output, stdout, stderr };
}

describe('fleet job tail line control', () => {
  it.each(['live', 'archived'] as const)('forwards the limit to the real %s log reader and preserves JSON metadata', async source => {
    const contents = `${lines.join('\n')}\n`;
    const data = source === 'live' ? Buffer.from(contents) : gzipSync(contents);
    await writeFile(join(runs, source === 'live' ? 'JOB1.log' : 'JOB1.log.gz'), data);
    const { deps, detail, changes, text, output, stderr } = setup();

    expect(await cmdFleetJobRead(['JOB1', '--log', '--tail-lines', '3', '--json'], deps)).toBe(0);
    expect(detail).toHaveBeenCalledExactlyOnceWith('JOB1', { maxTailLines: 3 });
    expect(changes).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      schema: 'fleet.job.log.v1', job: 'JOB1', generatedAt: clock().toISOString(),
      log: { source, bytes: data.length, tail: lines.slice(-3), truncated: true },
      sources: { log: 'healthy' },
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('retains the 120-line default and accepts both limits', async () => {
    await writeFile(join(runs, 'JOB1.log'), `${lines.join('\n')}\n`);
    const { deps, detail, output } = setup();
    for (const count of [undefined, '1', '120']) {
      const args = ['JOB1', '--log', '--json', ...(count ? ['--tail-lines', count] : [])];
      expect(await cmdFleetJobRead(args, deps)).toBe(0);
      const result = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(result.log.tail).toEqual(lines.slice(-(count ? Number(count) : 120)));
      expect(result.log.truncated).toBe(true);
    }
    expect(detail.mock.calls).toEqual([['JOB1'], ['JOB1', { maxTailLines: 1 }], ['JOB1', { maxTailLines: 120 }]]);
  });

  it('prints the exact short human tail and reader truncation status', async () => {
    await writeFile(join(runs, 'JOB1.log.gz'), gzipSync('first\nlast\n'));
    const { deps, stdout, stderr } = setup();
    expect(await cmdFleetJobRead(['--tail-lines', '2', '--log', 'JOB1'], deps)).toBe(0);
    expect(stdout).toHaveBeenCalledExactlyOnceWith('first\nlast\n');
    expect(stderr).toHaveBeenCalledExactlyOnceWith('Log: archived; health: healthy; truncated: no\n');
  });

  it('rejects bad counts and selector combinations before calling any reader, even with help', async () => {
    const { deps, detail, changes, text } = setup();
    const invalid = [
      ['JOB1', '--tail-lines', '3'],
      ...['--changes', '--prompt', '--notes'].map(selector => ['JOB1', selector, '--tail-lines', '3']),
      ...['--changes', '--prompt', '--notes'].map(selector => ['JOB1', '--log', selector, '--tail-lines', '3']),
      ['--help', '--tail-lines', '3'], ['--help', '--log', '--tail-lines', '0'],
      ['JOB1', '--log', '--tail-lines'], ['JOB1', '--log', '--tail-lines', '--json'],
      ...['0', '121', '-1', '1.5', '1e1', '1\n', 'abc', '999999999999999999999'].map(count => ['JOB1', '--log', '--tail-lines', count]),
      ['JOB1', '--log', '--tail-lines', '2', '--tail-lines', '3'],
    ];
    for (const args of invalid) expect(await cmdFleetJobRead(args, deps), args.join(' ')).toBe(2);
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('documents the range and an agent example in help without reading', async () => {
    const { deps, detail, changes, text, output } = setup();
    expect(await cmdFleetJobRead(['--help'], deps)).toBe(0);
    expect(output.mock.calls[0]?.[0]).toContain('--tail-lines accepts 1..120 with --log');
    expect(output.mock.calls[0]?.[0]).toContain('phm fleet job JOB1 --log --tail-lines 10 --json');
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });
});
