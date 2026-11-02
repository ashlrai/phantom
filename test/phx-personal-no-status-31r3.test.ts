import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as collector from '../src/core/fleet/codex-session-usage.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const roots: string[] = [];
const now = Date.parse('2036-10-31T12:00:00Z');
const observedAt = '2036-10-31T10:00:00Z';

async function setup(status?: string) {
  const root = await mkdtemp(join(tmpdir(), 'fake-personal-no-status-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const personalCodexHome = join(root, 'personal');
  if (status !== undefined) {
    await mkdir(join(runsDir, 'queue'), { recursive: true });
    await writeFile(join(runsDir, 'queue', 'status.json'), status);
  }
  return { root, runsDir, personalCodexHome };
}

async function session(home: string, secondary: unknown, at = observedAt) {
  const dir = join(home, 'sessions', '2036', '10', '31');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rollout-fake.jsonl'), JSON.stringify({ timestamp: at, type: 'event_msg', payload: {
    type: 'token_count', rate_limits: {
      primary: { used_percent: 15, window_minutes: 300, resets_at: null }, secondary,
    },
  } }) + '\n');
}

const weekly = { used_percent: 73, window_minutes: 10080, resets_at: null };
const healthyStatus = JSON.stringify({ last_tick: '2036-10-31T11:00:00Z', lanes: { claude: { running: 2 } } });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('personal usage without a dispatch status lane', () => {
  it.each([
    ['missing', undefined, 'missing', null],
    ['malformed', '{', 'degraded', null],
    ['healthy without personal lane', healthyStatus, 'healthy', '2036-10-31T11:00:00Z'],
  ])('reports observed weekly usage with %s status', async (_kind, status, health, asOf) => {
    const opts = await setup(status);
    await session(opts.personalCodexHome, weekly);
    const ledger = await readResourceLedger({ ...opts, now: () => now });
    expect(ledger.sources).toEqual({ status: health, jobs: 'missing', apiSpend: 'missing' });
    expect(ledger.asOf).toBe(asOf);
    expect(ledger.lanes.filter(lane => lane.lane === 'codex-personal')).toEqual([{
      lane: 'codex-personal', running: null, target: null, held: null, window: 'weekly',
      usedPct: 73, creditsRemaining: null, resetAt: null, burnPctPerHour: null,
      tokensPerHour6h: null, projectedExhaustion: null, source: 'codex-personal-sessions',
      deadSignal: null, observation: { source: 'codex-personal-sessions', asOf: '2036-10-31T10:00:00.000Z' },
    }]);
    if (status === healthyStatus) expect(ledger.lanes.find(lane => lane.lane === 'claude')).toMatchObject({ running: 2 });
  });

  it.each([
    ['no session', undefined, observedAt],
    ['session window only', null, observedAt],
    ['short secondary window', { used_percent: 33, window_minutes: 300, resets_at: null }, observedAt],
    ['invalid weekly reading', { used_percent: -1, window_minutes: 10080 }, observedAt],
    ['future reading', weekly, '2036-11-01T00:00:00Z'],
  ])('does not fabricate a lane with %s', async (_kind, secondary, at) => {
    const opts = await setup();
    if (secondary !== undefined) await session(opts.personalCodexHome, secondary, at);
    const ledger = await readResourceLedger({ ...opts, now: () => now });
    expect(ledger.sources.status).toBe('missing');
    expect(ledger.lanes).toEqual([]);
  });

  it('preserves newer status for an existing lane', async () => {
    const opts = await setup(JSON.stringify({ last_tick: '2036-10-31T11:00:00Z',
      lanes: { 'codex-personal': { running: 2, target: 4, held: false } },
      budget: { 'codex-personal': { weekly_used_pct: 41, source: 'fake status' } },
    }));
    await session(opts.personalCodexHome, weekly);
    const ledger = await readResourceLedger({ ...opts, now: () => now });
    expect(ledger.lanes).toHaveLength(1);
    expect(ledger.lanes[0]).toMatchObject({ running: 2, target: 4, held: false, usedPct: 41, source: 'fake status' });
    expect(ledger.lanes[0]?.observation).toBeUndefined();
  });

  it('collects only the supplied personal home despite inherited CMP overrides', async () => {
    const opts = await setup();
    const fakeCmp = join(opts.root, 'fake-cmp');
    await session(fakeCmp, { ...weekly, used_percent: 99 }, '2036-10-31T11:00:00Z');
    await session(opts.personalCodexHome, weekly);
    vi.stubEnv('CODEX_HOME', fakeCmp);
    vi.stubEnv('CODEX_HOME_ALT', fakeCmp);
    const collect = vi.spyOn(collector, 'collectCodexSessionUsages');
    const ledger = await readResourceLedger({ ...opts, now: () => now });
    expect(ledger.lanes[0]?.usedPct).toBe(73);
    expect(collect).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({
      env: { CODEX_HOME: opts.personalCodexHome, CODEX_HOME_ALT: opts.personalCodexHome },
    }));
  });
});
