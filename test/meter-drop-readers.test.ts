import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultMeterDropReaders } from '../src/core/fleet/meter-drop-readers.js';
import { readMeterDrop } from '../src/cli/fleet-meter-drop.js';

const now = Date.parse('2026-11-21T04:00:00Z');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function homeWith(status: unknown, history: unknown[] = []): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'meter-readers-')); dirs.push(home);
  await mkdir(join(home, '.ashlr-runs/queue'), { recursive: true });
  await mkdir(join(home, '.ashlr-runs/metrics'), { recursive: true });
  await writeFile(join(home, '.ashlr-runs/queue/status.json'), JSON.stringify(status));
  await writeFile(join(home, '.ashlr-runs/metrics/usage-history.json'), JSON.stringify({ schema: 'fleet.usage-history.v1', rows: history }));
  return home;
}
const status = (running: number, observedAt: string) => ({
  last_tick: observedAt,
  lanes: { claude: { running, target: 8, queued: 2, held: false } },
  budget: { claude: { weekly_used_pct: 32, reset_at: '2026-11-25T00:00:00Z', observed_at: observedAt, source: 'fixture' } },
});
const row = (used: number, at: string) => ({ pool: 'claude', used_pct: used, observed_at: at, reset_at: '2026-11-25T00:00:00Z', source: 'fixture' });

it('reads running from the daemon status and a flat history as an incident', async () => {
  const home = await homeWith(status(3, '2026-11-21T03:58:00Z'), [row(32, '2026-11-21T02:00:00Z')]);
  const report = await readMeterDrop(defaultMeterDropReaders(home, now), now);
  expect(report.providers).toHaveLength(1);
  expect(report.providers[0]).toMatchObject({ provider: 'claude', running: 3, verdict: 'flat' });
  expect(report.incidents).toBe(1);
});

it('says moving when the history shows a rise, idle with nothing running, stale for an old reading', async () => {
  const rising = await homeWith(status(3, '2026-11-21T03:58:00Z'), [row(30, '2026-11-21T02:00:00Z')]);
  expect((await readMeterDrop(defaultMeterDropReaders(rising, now), now)).providers[0]!.verdict).toBe('moving');
  const quiet = await homeWith(status(0, '2026-11-21T03:58:00Z'), [row(32, '2026-11-21T02:00:00Z')]);
  expect((await readMeterDrop(defaultMeterDropReaders(quiet, now), now)).providers[0]!.verdict).toBe('idle');
  const old = await homeWith(status(3, '2026-11-21T01:00:00Z'), [row(32, '2026-11-20T23:00:00Z')]);
  expect((await readMeterDrop(defaultMeterDropReaders(old, now), now)).providers[0]!.verdict).toBe('stale');
});

it('gives no readings, never a guess, when the status file is missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'meter-readers-')); dirs.push(home);
  const report = await readMeterDrop(defaultMeterDropReaders(home, now), now);
  expect(report.providers).toEqual([]);
});
