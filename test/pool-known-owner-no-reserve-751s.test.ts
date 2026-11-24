import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFleetPace } from '../src/core/fleet/pace-verdict.js';
import { paceStops } from '../src/core/fleet/pace-stops.js';
import { cmdPool } from '../src/cli/pool.js';

const now = Date.parse('2026-11-21T12:00:00Z');
const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
let root: string;
const read = () => readFleetPace({ runsDir: root, now: () => now });
const status = (budget: object = {}, lanes: object = {}, last_tick = at(0)) =>
  writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick, budget, lanes }));
const recorded = (pct: number, ts = now / 1000, reset_at = at(150)) =>
  writeFile(join(root, 'queue/claude-reading.json'), JSON.stringify({ pct, ts, reset_at, src: 'fake-provider' }));
const row = async () => (await read()).pools.find(p => p.pool === 'claude')!;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pool-owner-751s-'));
  await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it.each([95, 98, 99])('%s percent with high burn stays usable through the reader, stops and nested CLI', async pct => {
  await status({ claude: { use_it_all: { used_pct: pct, reset_at: at(150), burn_pct_per_hour: 20 } } });
  const data = await read();
  expect(data.pools.find(p => p.pool === 'claude')).toMatchObject({ usedPct: pct, verdict: 'over', state: 'ahead', safeBurnPerHour: (100 - pct) / 150 });
  const file = join(root, 'STOP-docs');
  await writeFile(file, 'written-by: phm pools pace\nclaude is over pace\n');
  expect((await paceStops(data, root, { claude: ['docs'] }, true)).plans[0]!.action).toBe('clear');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdPool(['why', 'claude', '--json'], { readPace: read })).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ usedPct: pct, source: 'queue/status.json', verdict: 'over' });
});
it('stops only on fresh measured exhaustion, preserving foreign stops and path checks', async () => {
  await recorded(100);
  const data = await read();
  expect(await row()).toMatchObject({ usedPct: 100, verdict: 'spent', safeBurnPerHour: 0 });
  const file = join(root, 'STOP-docs');
  await paceStops(data, root, { claude: ['docs'] }, true);
  expect(await readFile(file, 'utf8')).toContain('claude is spent');
  await writeFile(file, 'manual hold\n');
  await paceStops(data, root, { claude: ['docs'] }, true);
  expect(await readFile(file, 'utf8')).toBe('manual hold\n');
  await expect(paceStops(data, root, { claude: ['../escape'] }, true)).rejects.toThrow();
});
it.each(['stale', 'expired', 'missing', 'future'])('%s evidence never invents exhaustion or refill', async kind => {
  if (kind !== 'missing') await recorded(100, now / 1000 + (kind === 'stale' ? -25 * 3600 : kind === 'future' ? 3600 : 0), at(kind === 'expired' ? -1 : 150));
  const data = await read(), p = await row();
  expect(p).toMatchObject({ usedPct: null, safeBurnPerHour: null, hoursToEmpty: null });
  expect(['unknown', 'stale']).toContain(p.verdict);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdPool(['why', 'claude', '--json'], { readPace: read });
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ usedPct: null, verdict: p.verdict });
  expect((await paceStops(data, root, { claude: ['docs'] }, true)).plans[0]!.action).toBe('keep');
  await expect(readFile(join(root, 'STOP-docs'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('keeps measured zero and the newest valid source without reviving rejected status', async () => {
  await status({ claude: { used_pct: 100, observed_at: at(0), reset_at: at(150), known: false } });
  expect(await row()).toMatchObject({ usedPct: null, verdict: 'unknown' });
  await recorded(0, now / 1000 - 60);
  expect(await row()).toMatchObject({ usedPct: 0, source: 'queue/claude-reading.json' });
  await status({ claude: { use_it_all: { used_pct: 100, observed_at: at(0), reset_at: at(150), stale: true } } });
  expect(await row()).toMatchObject({ usedPct: 0, source: 'queue/claude-reading.json' });
  await writeFile(join(root, 'metrics/usage-history.json'), JSON.stringify({ schema: 'fleet.usage-history.v1', v: 1,
    rows: [{ pool: 'claude', used_pct: 1, observed_at: at(0), reset_at: at(150), source: 'fake' }] }));
  expect(await row()).toMatchObject({ usedPct: 1, source: 'metrics/usage-history.json' });
});
it('reports held and zero-target free lanes with no headroom, and stale slots as unknown', async () => {
  await status({}, { 'codex-local': { target: 3, running: 0, held: true }, 'devin-flash': { target: 0 } });
  for (const p of (await read()).pools.filter(p => p.headroom)) expect(p).toMatchObject({ state: 'unknown', headroom: { slots: 0 } });
  await status({}, { 'devin-flash': { target: 3, running: 0 } }, at(-1));
  expect((await read()).pools.find(p => p.pool === 'devin-flash')).toMatchObject({ verdict: 'unknown', headroom: { slots: null } });
});
it('does not follow recorded-reading links or invent usage from malformed metadata', async () => {
  await writeFile(join(root, 'fake'), JSON.stringify({ pct: 100, ts: now / 1000, reset_at: at(150) }));
  await symlink(join(root, 'fake'), join(root, 'queue/claude-reading.json'));
  expect(await row()).toMatchObject({ usedPct: null, verdict: 'unknown' });
});
it('skips an expired newer reading for valid evidence and never borrows rejected status burn', async () => {
  await recorded(100, now / 1000, at(-1));
  await status({ claude: { used_pct: 0, observed_at: at(-0.5), reset_at: at(10), burn_pct_per_hour: 2 } });
  expect(await row()).toMatchObject({ usedPct: 0, source: 'queue/status.json', recentPerHour: 2 });
  await recorded(99);
  await status({ claude: { used_pct: 100, observed_at: at(0), reset_at: at(10), burn_pct_per_hour: 100, stale: true } });
  expect(await row()).toMatchObject({ usedPct: 99, recentPerHour: null, verdict: 'unknown' });
});
