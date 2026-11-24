import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { detectPoolCap } from '../src/core/fleet/empty-why-classify.js';
import { emptyFamilyReason } from '../src/core/fleet/empty-families.js';
import { readJobsEmptyWhy } from '../src/core/fleet/jobs-empty-why.js';
import { activeCaps, capFromLog, pickModel, readLiveCaps, recordCapFromLog, recordModelSuccess } from '../src/core/fleet/model-caps.js';

const now = Date.parse('2026-11-19T20:00:00Z');
const FABLE = "You've reached your Fable limit. Switch to another model, or manage usage credits to continue.";
const CODEX = 'Error: You have hit your usage limit. Try again later.';
const GENERIC = 'request failed: rate limit exceeded, retry later';
const dirs: string[] = [];
const scratch = async () => { const d = await mkdtemp(join(tmpdir(), 'caps-')); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

it('names the model in the Claude message and leaves it null for plan-wide and generic limits', () => {
  expect(detectPoolCap(FABLE)).toEqual({ model: 'fable', kind: 'model-limit' });
  expect(detectPoolCap(CODEX)).toEqual({ model: null, kind: 'plan-limit' });
  expect(detectPoolCap("You've hit your usage limit")).toEqual({ model: null, kind: 'plan-limit' });
  expect(detectPoolCap(GENERIC)).toEqual({ model: null, kind: 'rate-limit' });
});
it('does not call an ordinary empty or a sign-in failure a pool cap', () => {
  expect(detectPoolCap('RESULT EMPTY\nno changes needed')).toBeNull();
  expect(detectPoolCap(null)).toBeNull();
  expect(emptyFamilyReason('authentication failed: please log in again', null)).toBe('auth_failed');
  expect(emptyFamilyReason('RESULT EMPTY\nalready on master', null)).toBe('already-on-master');
  expect(emptyFamilyReason(FABLE, null)).toBe('pool_cap');
});
it('shows pool-cap in jobs empty-why, not unknown or tool-error', async () => {
  const ledger = JSON.stringify({ job: 'RQ-CAP-1', ts: new Date(now - 1000).toISOString(), event: 'finish', empty: true });
  const report = await readJobsEmptyWhy(ledger, '/runs', 24, now, async () => FABLE);
  expect(report.jobs[0]!.reason).toBe('pool-cap');
});
it('records a Fable mark with the worker-log source and nothing for an ordinary empty', async () => {
  const dir = await scratch();
  expect(await recordCapFromLog(dir, 'RESULT EMPTY', 'claude', now)).toBeNull();
  expect(await recordCapFromLog(dir, CODEX, 'codex', now)).toBeNull();
  const cap = await recordCapFromLog(dir, FABLE, 'claude', now, '2026-11-20T05:00:00Z');
  expect(cap).toMatchObject({ model: 'fable', source: 'worker-log', lane: 'claude', capped_at: new Date(now).toISOString() });
  expect(await readLiveCaps(now, dir)).toHaveLength(1);
});
it('clears a mark at the reset time and at the first later success', async () => {
  const cap = capFromLog(FABLE, 'claude', now, '2026-11-20T05:00:00Z')!;
  expect(activeCaps([cap], now + 3_600_000)).toHaveLength(1);
  expect(activeCaps([cap], Date.parse('2026-11-20T05:00:00Z'))).toHaveLength(0);
  expect(activeCaps([cap], now + 1000, { fable: now - 1 })).toHaveLength(1);
  expect(activeCaps([cap], now + 1000, { fable: now + 500 })).toHaveLength(0);
  const dir = await scratch();
  await recordCapFromLog(dir, FABLE, 'claude', now);
  expect(await recordModelSuccess(dir, 'claude', 'fable')).toBe(true);
  expect(await readLiveCaps(now, dir)).toEqual([]);
  expect(await recordModelSuccess(dir, 'claude', 'fable')).toBe(false);
});
it('falls frontier to Opus then Sonnet with the reason, and reports unknown for an unmapped lane', () => {
  const fable = capFromLog(FABLE, 'claude', now)!;
  const opus = { ...fable, model: 'opus' };
  expect(pickModel('claude', 'frontier', [], now)).toMatchObject({ model: 'fable', skipped: [] });
  const one = pickModel('claude', 'frontier', [fable], now);
  expect(one).toMatchObject({ model: 'opus', requested: 'fable' });
  expect(one.skipped[0]!.reason).toContain('fable hit its usage limit');
  expect(pickModel('claude', 'frontier', [fable, opus], now).model).toBe('sonnet');
  expect(pickModel('claude', 'frontier', [{ ...fable, lane: 'codex' }], now).model).toBe('fable');
  expect(pickModel('claude', 'light', [{ ...fable, model: 'sonnet' }], now)).toMatchObject({ model: null, known: true });
  expect(pickModel('codex', 'work', [], now)).toMatchObject({ model: null, known: false });
});
