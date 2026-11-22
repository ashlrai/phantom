import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { reservePace } from '../src/core/usage/reserve-pace.js';
import { buildFleetPace, readFleetPace } from '../src/core/fleet/pace-verdict.js';
import { paceStops } from '../src/core/fleet/pace-stops.js';
import { cmdPoolWhy } from '../src/cli/pool-why.js';
import { cmdPool } from '../src/cli/pool.js';
import { cmdFleetPace } from '../src/cli/fleet-pace.js';
const now = Date.parse('2026-11-21T12:00:00Z'), at = (h: number) => new Date(now + h * 3_600_000).toISOString();
let root: string;
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });
const input = (usedPct = 75, hoursLeft = 150, burnPctPerHour: number | null = 1.7) => ({ id: 'claude', usedPct, hoursLeft, burnPctPerHour, resetAt: at(hoursLeft) });
const report = (used = 75, hours = 150, burn: number | null = 1.7) => buildFleetPace({ generatedAt: at(0), pools: [input(used, hours, burn)] }, now);
it('reserves five percent, shows the measured empty time and keeps unknowns unknown', () => {
  expect(reservePace(input())).toMatchObject({ verdict: 'over', safeBurnPerHour: 20 / 150 });
  expect(reservePace(input()).line).toContain('empty in about 15 h');
  expect(reservePace(input(99, 10, 1)).safeBurnPerHour).toBe(0);
  expect(reservePace(input(20, 10, 1)).verdict).toBe('ok');
  expect(reservePace(input(75, 150, null))).toMatchObject({ verdict: 'unknown', hoursToEmpty: null });
});
it('reads every budget pool, prefers the last pair and falls back to reported burn', async () => {
  root = await mkdtemp(join(tmpdir(), 'pace-'));
  await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at(0), budget: {
    claude: { use_it_all: { known: true, stale: false, used_pct: 75, hours_to_reset: 150, reset_at: at(150), burn_pct_per_hour: 1 } },
    gemini: { use_it_all: { used_pct: 20, hours_to_reset: 10, burn_pct_per_hour: 1 } }, grok: {},
  } }));
  await writeFile(join(root, 'metrics/usage-history.json'), JSON.stringify({ schema: 'fleet.usage-history.v1', v: 1, rows: [-1, 0].map(h => ({ pool: 'claude', used_pct: 75 + 1.7 * h, observed_at: at(h), reset_at: at(150), source: null })) }));
  const data = await readFleetPace({ runsDir: root, now: () => now });
  expect(data.pools.filter(p => ['claude', 'gemini', 'grok'].includes(p.pool))).toMatchObject([{ pool: 'claude', verdict: 'over', recentPerHour: 1.7 }, { pool: 'gemini', verdict: 'ok' }, { pool: 'grok', verdict: 'unknown' }]);
});
it('plans by default, applies and clears owned stops, preserving foreign files and links', async () => {
  root = await mkdtemp(join(tmpdir(), 'pace-'));
  const file = join(root, 'STOP-docs'), config = { claude: ['docs'] };
  await paceStops(report(), root, config); await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await paceStops(report(), root, config, true); expect(await readFile(file, 'utf8')).toBe('written-by: phm pools pace\nclaude is over pace\n');
  await paceStops(report(75, 150, null), root, config, true); expect(await readFile(file, 'utf8')).toContain('written-by');
  await paceStops(report(20, 10, 1), root, config, true); await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(file, 'manual hold\n'); await paceStops(report(), root, config, true); await paceStops(report(20, 10, 1), root, config, true);
  expect(await readFile(file, 'utf8')).toBe('manual hold\n'); await rm(file);
  await writeFile(join(root, 'manual'), 'written-by: phm pools pace\nmanual hold\n'); await symlink(join(root, 'manual'), file);
  await paceStops(report(20, 10, 1), root, config, true); expect(await readFile(file, 'utf8')).toContain('manual hold');
  await expect(paceStops(report(), root, { claude: ['../docs'] }, true)).rejects.toThrow();
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  await writeFile(join(root, 'loops.json'), JSON.stringify(config));
  expect(await cmdFleetPace(['--write-stops', root, '--loops', join(root, 'loops.json'), '--json'], { read: async () => report() })).toBe(0);
  expect(await cmdFleetPace(['--apply'], { read: async () => report() })).toBe(2);
});

it('explains free slots, stale provider records, history and exhausted pools without negative burn', async () => {
  root = await mkdtemp(join(tmpdir(), 'pool-'));
  await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at(0), lanes: {
    'codex-local': { running: 1, target: 3 }, 'devin-flash': { running: 0, target: 2 }, devin: { target: 0 },
  }, budget: { 'codex-cmp': { weekly_used_pct: 100, reset_at: at(12), observed_at: at(0) } } }));
  await writeFile(join(root, 'queue/grok-reading.json'), JSON.stringify({ pct: 30, ts: now / 1000 - 72 * 3600, reset_at: (now / 1000) + 3600, src: 'provider' }));
  await writeFile(join(root, 'metrics/usage-history.json'), JSON.stringify({ schema: 'fleet.usage-history.v1', v: 1,
    rows: [-1, 0].map(h => ({ pool: 'cursor', used_pct: 20 + h, observed_at: at(h), reset_at: at(10), source: 'provider' })) }));
  const read = () => readFleetPace({ runsDir: root, now: () => now });
  const data = await read(), rows = Object.fromEntries(data.pools.map(p => [p.pool, p]));
  expect(data.pools).toHaveLength(12);
  expect(rows['codex-local']).toMatchObject({ state: 'behind', verdict: 'free', headroom: { slots: 2 } });
  expect(rows['codex-local']!.headroom!.ramBytes).toBeGreaterThan(0);
  expect(rows['devin-flash']).toMatchObject({ state: 'behind', verdict: 'free', headroom: { slots: 2 } });
  expect(rows.grok).toMatchObject({ verdict: 'stale', ageHours: 72, usedPct: null, line: 'grok: stale (72h); refresh the provider reading' });
  expect(rows['codex-cmp']).toMatchObject({ state: 'ahead', verdict: 'spent', safeBurnPerHour: 0, line: `codex-cmp: spent until ${at(12)}` });
  expect(rows.cursor).toMatchObject({ usedPct: 20, recentPerHour: 1, source: 'metrics/usage-history.json' });
  expect(rows.devin!.source).toContain('queue/devin-reading.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdPoolWhy(['grok', '--json'], read)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ schema: 'pool.why.v1', verdict: 'stale', explanation: expect.stringContaining('stale (72h)') });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdPool(['why', '../bad'])).toBe(2);
  expect(await cmdPoolWhy(['absent'], read)).toBe(1);
  expect(error).toHaveBeenCalledTimes(2);
});
