import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
    paths.push(String(args[0]));
    return fs.readdirSync(...args);
  }) as typeof fs.readdirSync;
  return { ...fs, readdirSync };
});
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import { quotaEvidence, type QuotaMeasurement } from '../src/core/fleet/resource-reset-evidence.js';

const now = Date.parse('2036-06-14T12:00:00Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
let root: string;
let personal: string;
let statusText: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reset-ledger-fake-'));
  personal = join(root, 'fake-personal');
  mkdirSync(join(root, 'queue'));
  paths.length = 0;
  status();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function status(used = 100, reset = iso(86_400_000), tick: string | null = iso(-600_000)) {
  statusText = JSON.stringify({ last_tick: tick,
    lanes: { 'codex-personal': { held: true }, 'codex-cmp': { held: true } },
    budget: { 'codex-personal': { weekly_used_pct: used, reset_at: reset, source: 'fake-status' },
      'codex-cmp': { weekly_used_pct: 100, reset_at: reset } } });
  writeFileSync(join(root, 'queue/status.json'), statusText);
}
function rollout(used: number, at = iso(-30_000), minutes = 10080, reset = iso(86_400_000)) {
  const dir = join(personal, 'sessions', '2036', '06', '14');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rollout-fake.jsonl'), JSON.stringify({ timestamp: at, type: 'event_msg',
    payload: { type: 'token_count', private_content: 'fake-private-message', rate_limits: {
      secondary: { used_percent: used, window_minutes: minutes, resets_at: Date.parse(reset) / 1000 },
    } } }) + '\n');
}
const read = () => readResourceLedger({ runsDir: root, personalCodexHome: personal, now: () => now });
it('publishes early/manual recovery in ledger JSON while preserving the hold and status file', async () => {
  rollout(0);
  const ledger = await read();
  expect(ledger.lanes[0]).toMatchObject({ held: true, usedPct: 0, source: 'codex-personal-sessions',
    quotaEvidence: { state: 'observed-headroom', reason: 'quota-recovered', holdConflict: 'recovered-quota-while-held',
      statusQuota: { usedPct: 100, source: 'fake-status', observedAt: iso(-600_000) },
      measuredQuota: { usedPct: 0, source: 'codex-personal-sessions', observedAt: iso(-30_000) } } });
  expect(ledger.lanes[1]!.quotaEvidence?.holdConflict).toBeNull();
  const serialized = JSON.stringify(ledger);
  expect(serialized).toContain('quota-recovered');
  for (const privateValue of [root, 'fake-private-message', 'rollout-fake']) expect(serialized).not.toContain(privateValue);
  expect(readFileSync(join(root, 'queue/status.json'), 'utf8')).toBe(statusText);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every(path => path.startsWith(personal + '/sessions'))).toBe(true);
});
it.each([-300_001, 1])('cannot recover using stale/future measurement (%s ms)', async offset => {
  rollout(0, iso(offset));
  expect((await read()).lanes[0]!.quotaEvidence?.reason).not.toBe('quota-recovered');
  expect((await read()).lanes[0]!.held).toBe(true);
});
it('treats 100 used as exhausted, never as 100 remaining', async () => {
  status(0);
  rollout(100);
  expect((await read()).lanes[0]!.quotaEvidence).toMatchObject({ state: 'exhausted', holdConflict: null });
});
it('requires a reading after the reset passes and does not invent zero usage', async () => {
  status(100, iso(-1));
  const lane = (await read()).lanes[0]!;
  expect(lane).toMatchObject({ usedPct: 100, held: true, quotaEvidence: { state: 'refresh-needed', reason: 'reset-passed' } });
});
it.each([300, 10080])('rejects nonweekly or expired measurement windows (%s minutes)', async minutes => {
  rollout(0, iso(-30_000), minutes, minutes === 300 ? iso(86_400_000) : iso(-1));
  expect((await read()).lanes[0]!.quotaEvidence?.reason).not.toBe('quota-recovered');
});
it('preserves missing and degraded source states', async () => {
  status(100, iso(86_400_000), null);
  rollout(0);
  expect((await read()).sources).toEqual({ status: 'degraded', apiSpend: 'missing', jobs: 'missing' });
  expect((await read()).lanes[0]!.quotaEvidence?.reason).not.toBe('quota-recovered');
  rmSync(join(root, 'queue/status.json'));
  expect((await read()).sources.status).toBe('missing');
});
it('compares provider-neutral weekly rows without crossing accounts or reversed boundaries', () => {
  const old: QuotaMeasurement = { lane: 'fake-provider-seat', window: 'weekly', usedPct: 100,
    resetAt: iso(1000), observedAt: iso(-600_000), source: 'fake-status' };
  const measured = { ...old, usedPct: 0, observedAt: iso(-1) };
  expect(quotaEvidence(old, measured, true, now).reason).toBe('quota-recovered');
  expect(quotaEvidence(old, { ...measured, lane: 'other-seat' }, true, now).holdConflict).toBeNull();
  expect(quotaEvidence(old, { ...measured, resetAt: iso(500) }, true, now).holdConflict).toBeNull();
});
