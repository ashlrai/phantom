import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStuck } from '../src/cli/fleet-stuck.js';
import { cmdFleetYield } from '../src/cli/fleet-yield.js';
import { cmdQueueCoalesce } from '../src/cli/queue-coalesce.js';

describe('fleet throughput guide command examples', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('reports unavailable stuck and yield inputs as unknown with their actual exit codes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'throughput-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStuck(['--events', join(dir, 'missing-events'), '--ready', join(dir, 'missing-ready'), '--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ count: null, jobs: [], sources: { events: 'missing' } });
    expect(await cmdFleetYield(['--since', '24h', '--metrics', join(dir, 'missing-metrics'), '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ known: false, launches: 0, window_hours: 24 });
  });

  it('plans eligible jobs and preserves exclusions without changing files on dry run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'throughput-'));
    dirs.push(dir);
    const path = join(dir, 'router-queue.md');
    const input = [
      '- READY RQ-ONE-1 (P1, pool=work, tier=work, repo=demo, size<=100): First task',
      '- READY RQ-TWO-1 (P1, pool=work, tier=work, repo=demo, size<=200): Second task',
      '- READY RQ-URGENT-1 (P0, pool=work, tier=work, repo=demo, size<=10): Urgent',
      '- READY RQ-LARGE-1 (P1, pool=work, tier=work, repo=demo): Unknown size',
      '',
    ].join('\n');
    await writeFile(path, input);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueueCoalesce([path, '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(report).toMatchObject({ applied: false, out: null, batches: [{ replaces: ['RQ-ONE-1', 'RQ-TWO-1'] }] });
    expect(report.kept).toEqual(expect.arrayContaining([{ id: 'RQ-URGENT-1', reason: 'P0' }, { id: 'RQ-LARGE-1', reason: 'not small' }]));
    expect(await readdir(dir)).toEqual(['router-queue.md']);
    expect(await readFile(path, 'utf8')).toBe(input);
  });
});
