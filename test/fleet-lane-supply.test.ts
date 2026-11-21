import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetLaneSupply } from '../src/cli/fleet-lane-supply.js';
import { readLaneSupply } from '../src/core/fleet/lane-supply-read.js';

afterEach(() => vi.restoreAllMocks());
const capture = () => { const out: string[] = []; vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); }); vi.spyOn(console, 'error').mockImplementation(() => {}); return out; };

describe('phm fleet lane-supply', () => {
  it('reads a host-shaped runs dir end to end: idle lane alarms, the other lanes do not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lane-supply-'));
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue', 'ready.tsv'), 'READY\tjob-one\tcodex\ttier1\tphantom\tone plain title\n');
    await writeFile(join(dir, 'queue', 'usage-readings.log'), [
      { pool: 'claude', pctUsed: 32, resetAt: '2026-11-22T12:00:00Z', observedAt: '2026-11-20T11:59:00Z' },
      { pool: 'codex', pctUsed: 100, resetAt: '2026-11-21T06:00:00Z', observedAt: '2026-11-20T11:59:00Z' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const report = await readLaneSupply({ runsDir: dir, now: () => Date.parse('2026-11-20T12:00:00Z') });
    expect(report.schema).toBe('fleet.lane-supply.v1');
    expect(report.planner.state).toBe('unknown');
    expect(report.lanes.find(l => l.lane === 'codex')).toMatchObject({ queued: 1, usedPct: 100 });
  });

  it('prints JSON and exits 1 while a lane is idle with usage left', async () => {
    const out = capture();
    const report = { schema: 'fleet.lane-supply.v1', generatedAt: 'x', lanes: [], idle: ['claude'], alarm: 'claude idle: 6 free slots, 68% left',
      planner: { state: 'unknown', lastPassAt: null, ageSeconds: null }, autofill: { state: 'unknown', items: null, note: null } } as const;
    expect(await cmdFleetLaneSupply(['--json'], async () => ({ ...report, idle: [...report.idle] }))).toBe(1);
    expect(JSON.parse(out[0]!).alarm).toBe('claude idle: 6 free slots, 68% left');
  });

  it('exits 0 when nothing is idle, 2 on bad arguments, and prints help without reading', async () => {
    const out = capture();
    const read = vi.fn(async () => ({ schema: 'fleet.lane-supply.v1', generatedAt: 'x', lanes: [], idle: [], alarm: null,
      planner: { state: 'unknown', lastPassAt: null, ageSeconds: null }, autofill: { state: 'unknown', items: null, note: null } }) as never);
    expect(await cmdFleetLaneSupply([], read)).toBe(0);
    expect(out[0]).toContain('no lanes reported');
    expect(await cmdFleetLaneSupply(['--bogus'], read)).toBe(2);
    read.mockClear();
    expect(await cmdFleetLaneSupply(['--help'], read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
});
