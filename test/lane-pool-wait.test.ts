import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdLanes } from '../src/cli/lanes.js';
import { gapLaneRoom } from '../src/core/fleet/gap-lane-room.js';
import { lanePoolWait } from '../src/core/fleet/lane-pool-wait.js';

const NOW = Date.parse('2026-11-21T06:00:00Z');
const LATER = '2026-11-21T20:30:00Z';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('says waiting until reset when used 100, 10 queued, none running', () => {
  const r = lanePoolWait({ queued: 10, running: 0, usedPct: 100, resetAt: LATER }, NOW);
  expect(r).toMatchObject({ state: 'waiting', waitingRows: 10 });
  expect(r.words).toMatch(/^waiting on a used-up pool until .+ \(10 rows\)$/);
});

it('is normal at 45% used, and when a job is running or nothing is queued', () => {
  expect(lanePoolWait({ queued: 10, running: 0, usedPct: 45, resetAt: LATER }, NOW).state).toBe('normal');
  expect(lanePoolWait({ queued: 10, running: 2, usedPct: 100, resetAt: LATER }, NOW).state).toBe('normal');
  expect(lanePoolWait({ queued: 0, running: 0, usedPct: 100, resetAt: LATER }, NOW).state).toBe('normal');
  expect(lanePoolWait({ queued: 10, running: 0, usedPct: 97, resetAt: LATER }, NOW).state).toBe('normal');
});

it('says no meter, not normal, without a reading', () => {
  const r = lanePoolWait({ queued: 10, running: 0, usedPct: null, resetAt: null }, NOW);
  expect(r.state).toBe('no-meter');
  expect(r.words).toContain('no meter');
});

it('treats a reset already past as a stale reading, not a wait', () => {
  expect(lanePoolWait({ queued: 3, running: 0, usedPct: 100, resetAt: '2026-11-21T05:00:00Z' }, NOW).state).toBe('normal');
});

it('the gaps room counts a 98% used pool as stuck rows', () => {
  const room = gapLaneRoom([{ lane: 'codex-personal', running: 0, target: 1, queued: 10, held: false, remainingPct: 2, resetAt: LATER }], NOW);
  expect(room.stuck).toBe(10);
  expect(room.open).toEqual([]);
});

it('phm lanes pool prints plain words and JSON per lane', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pool-wait-'));
  vi.stubEnv('HOME', root);
  try {
    await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
    const lane = (queued: number) => ({ running: 0, target: 1, queued, held: false, healthy: true });
    await writeFile(join(root, '.ashlr-runs/queue/status.json'), JSON.stringify({
      last_tick: new Date().toISOString(), paused: false, mem_free_pct: 50,
      lanes: { 'codex-personal': lane(10), claude: lane(2), gemini: lane(1) },
      budget: { 'codex-personal': { weekly_used_pct: 100, reset_at: new Date(Date.now() + 3_600_000).toISOString() }, claude: { weekly_used_pct: 45 } },
    }));
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['pool'])).toBe(0);
    const text = out.mock.calls.map(c => String(c[0]));
    expect(text).toContain('claude: normal, pool 45% used');
    expect(text.find(l => l.startsWith('codex-personal:'))).toMatch(/waiting on a used-up pool until .+ \(10 rows\)/);
    expect(text).toContain('gemini: no meter: pool use is unknown');
    out.mockClear();
    expect(await cmdLanes(['pool', '--json'])).toBe(0);
    const json = JSON.parse(out.mock.calls[0]![0]);
    expect(json.schema).toBe('lanes.pool.v1');
    expect(json.lanes.find((l: { lane: string }) => l.lane === 'codex-personal')).toMatchObject({ state: 'waiting', waitingRows: 10 });
    out.mockClear();
    expect(await cmdLanes(['--json'])).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0]).lanes.find((l: { lane: string }) => l.lane === 'claude').poolWait.state).toBe('normal');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdLanes(['pool', '--x'])).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
