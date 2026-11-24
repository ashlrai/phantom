import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLanes } from '../src/cli/lanes.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function home(ledger: string | null): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-yield-'));
  dirs.push(root);
  if (ledger !== null) {
    await mkdir(join(root, '.ashlr-runs/metrics'), { recursive: true });
    await writeFile(join(root, '.ashlr-runs/metrics/jobs.jsonl'), ledger);
  }
  vi.stubEnv('HOME', root);
}
const ledger = Array.from({ length: 10 }, (_, i) => [
  JSON.stringify({ event: 'launch', job: `a${i}`, lane: 'claude', size: 'md', ts: '2026-11-19T10:00:00.000Z' }),
  ...(i < 7 ? [JSON.stringify({ event: 'outcome', job: `a${i}`, state: 'MERGED' })] : [JSON.stringify({ event: 'finish', job: `a${i}`, empty: true })]),
].join('\n')).join('\n');

describe('phm lanes yield', () => {
  it('prints typed JSON with a schema id', async () => {
    await home(ledger);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['yield', '--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls.at(-1)![0]);
    expect(report.schema).toBe('lanes.yield.v1');
    expect(report.rows.find((r: { size: string }) => r.size === 'md')).toMatchObject({ lane: 'claude', launches: 10, merged: 7, yield: 0.7, emptyRate: 0.3, weight: 1.4 });
  });

  it('says plainly when yield is unknown, and rejects bad flags', async () => {
    await home(null);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdLanes(['yield'])).toBe(0);
    expect(out.mock.calls.at(-1)![0]).toContain('unavailable');
    expect(await cmdLanes(['yield', '--bogus'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it('prints one plain line per row', async () => {
    await home(ledger);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['yield'])).toBe(0);
    expect(out.mock.calls.map(c => c[0])).toContain('claude / md: yield 70% (7 merged of 10 launches), empty 30%; router weight 1.40');
  });

  it('names reverted merges on the plain line and drops them from the yield', async () => {
    const reverted = `${ledger}\n${JSON.stringify({ event: 'revert', job: 'a0' })}\n${JSON.stringify({ event: 'revert', job: 'a1' })}`;
    await home(reverted);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['yield'])).toBe(0);
    expect(out.mock.calls.map(c => c[0])).toContain('claude / md: yield 50% (5 merged of 10 launches, 2 reverted), empty 30%; router weight 1.00');
  });

  it('gives every lane a verdict and honours --since', async () => {
    const zai = Array.from({ length: 20 }, (_, i) => [
      JSON.stringify({ event: 'launch', job: `z${i}`, lane: 'zai', size: 'md', ts: '2026-11-19T10:00:00.000Z' }),
      JSON.stringify({ event: 'finish', job: `z${i}`, empty: true, ts: '2026-11-19T10:05:00.000Z' }),
    ].join('\n')).join('\n');
    await home(zai);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['yield', '--json', '--since', '2000d'])).toBe(0);
    const report = JSON.parse(out.mock.calls.at(-1)![0]);
    expect(report.lanes.find((l: { lane: string }) => l.lane === 'zai')).toMatchObject({ jobs: 20, empty: 20, verdict: 'low-yield' });
    expect(await cmdLanes(['yield', '--since', '2000d'])).toBe(0);
    expect(out.mock.calls.map(c => c[0])).toContain('zai: low-yield (20 of 20 finished jobs ended empty, 0 merged in 2000d)');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdLanes(['yield', '--since', 'nonsense'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
