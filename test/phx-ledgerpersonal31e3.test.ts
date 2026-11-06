import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const roots: string[] = [];
const now = Date.parse('2036-10-31T12:00:00Z');
const statusAt = '2036-10-30T23:45:00Z';
async function setup(at: string | null = statusAt) {
  const root = await mkdtemp(join(tmpdir(), 'fake-ledger-personal-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const personalCodexHome = join(root, 'fake-personal');
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await writeFile(join(runsDir, 'queue', 'status.json'), JSON.stringify({ last_tick: at,
    lanes: { 'codex-personal': { running: 1 }, claude: {} },
    budget: { 'codex-personal': { weekly_used_pct: 99, reset_at: '2036-11-01T00:00:00Z', burn_pct_per_hour: 5, tokens_per_hour_6h: 9, projected_exhaustion: '2036-11-01T00:00:00Z', source: 'fake status' }, claude: { weekly_used_pct: 42 } } }));
  return { runsDir, personalCodexHome };
}
async function session(home: string, at: string, weekly: unknown = { used_percent: 73, window_minutes: 10080, resets_at: Date.parse('2036-11-07T12:00:00Z') / 1000 }) {
  const dir = join(home, 'sessions', '2036', '10', '31');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rollout-2036-10-31-fake.jsonl'), JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 22, window_minutes: 300, resets_at: Date.parse('2036-10-31T16:00:00Z') / 1000 }, secondary: weekly,
  } } }) + '\n');
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('personal session evidence in the resource ledger', () => {
  it('replaces stale status with newer personal weekly evidence, keeping Claude weekly', async () => {
    const opts = await setup();
    await session(opts.personalCodexHome, '2036-10-31T10:00:00Z');
    const ledger = await readResourceLedger({ ...opts, now: () => now });
    expect(ledger.asOf).toBe(statusAt);
    expect(ledger.lanes.find(lane => lane.lane === 'codex-personal')).toMatchObject({
      running: 1, window: 'weekly', usedPct: 73, resetAt: '2036-11-07T12:00:00.000Z',
      burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null,
      source: 'codex-personal-sessions', observation: { source: 'codex-personal-sessions', asOf: '2036-10-31T10:00:00.000Z' },
    });
    expect(ledger.lanes.find(lane => lane.lane === 'claude')).toMatchObject({ window: 'weekly', usedPct: 42 });
    expect(JSON.stringify(ledger)).not.toMatch(/"[^"]*(?:5h|fiveHour)[^"]*"\s*:/i);
  });
  it.each(['missing', 'no weekly', 'older', 'equal', 'future'])( 'preserves status with %s personal evidence', async kind => {
    const opts = await setup();
    if (kind !== 'missing') await session(opts.personalCodexHome,
      kind === 'older' ? '2036-10-30T20:00:00Z' : kind === 'equal' ? statusAt : kind === 'future' ? '2036-11-01T00:00:00Z' : '2036-10-31T10:00:00Z',
      kind === 'no weekly' ? null : undefined);
    const ledger = await readResourceLedger({ ...opts, now: () => now });
    expect(ledger.lanes[0]).toMatchObject({ usedPct: 99, source: 'fake status', burnPctPerHour: 5 });
    expect(ledger.lanes[0]?.observation).toBeUndefined();
  });
  it('does not replace dated-unknown status usage when freshness cannot be compared', async () => {
    const opts = await setup(null);
    await session(opts.personalCodexHome, '2036-10-31T10:00:00Z');
    expect((await readResourceLedger({ ...opts, now: () => now })).lanes[0]?.usedPct).toBe(99);
  });
  it('ignores inherited Codex account overrides', async () => {
    const opts = await setup();
    const unrelated = join(opts.runsDir, 'fake-other-account');
    await session(unrelated, '2036-10-31T11:00:00Z', { used_percent: 88, window_minutes: 10080, resets_at: null });
    await session(opts.personalCodexHome, '2036-10-31T10:00:00Z');
    vi.stubEnv('CODEX_HOME', unrelated);
    vi.stubEnv('CODEX_HOME_ALT', unrelated);
    expect((await readResourceLedger({ ...opts, now: () => now })).lanes[0]?.usedPct).toBe(73);
  });
  it('does not treat a file modification time as a dated weekly observation', async () => {
    const opts = await setup();
    const dir = join(opts.personalCodexHome, 'sessions', '2036', '10', '31');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'rollout-2036-10-31-fake.jsonl');
    await writeFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      secondary: { used_percent: 73, window_minutes: 10080, resets_at: null },
    } } }) + '\n');
    const modified = new Date('2036-10-31T10:00:00Z');
    await utimes(file, modified, modified);
    expect((await readResourceLedger({ ...opts, now: () => now })).lanes[0]?.usedPct).toBe(99);
  });
});
