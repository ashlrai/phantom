import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateLane, budgetEntryQuota, type LaneState } from '../src/core/fabric/lane-usage-self.js';
import { runSelfRefresh } from '../src/core/fabric/lane-usage-self-io.js';
import { runUsageSelf } from '../src/cli/usage-self.js';

// Preservation coverage for original PR #4934 (RQ-USAGE-SELF-2): the self-refresh capabilities it
// introduced must still reach budget-overrides.json and the autopilot's quota contract on current
// master, which later added bounded job-log reads, owned-field merging, expired-estimate rejection
// and quota TTL checks. All identifiers below are plainly fake; readers are injected and every path
// is a temp dir — no HOME, provider, token store or live process is touched.

const T0 = Date.parse('2026-11-10T12:00:00Z'); // a Tuesday
const FUTURE = new Date(T0 + 2 * 86_400_000).toISOString();
const PAST = new Date(T0 - 3_600_000).toISOString();

function makeRuns(overrides?: unknown, jobs?: string): { dir: string; overridesFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'usage-self-222s-'));
  mkdirSync(join(dir, 'queue'));
  mkdirSync(join(dir, 'metrics'));
  const overridesFile = join(dir, 'queue', 'budget-overrides.json');
  if (overrides !== undefined) writeFileSync(overridesFile, JSON.stringify(overrides));
  if (jobs !== undefined) writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), jobs);
  return { dir, overridesFile };
}

const readOverrides = (file: string): Record<string, any> => JSON.parse(readFileSync(file, 'utf8'));

describe('original #4934 refresh results reach budget-overrides.json', () => {
  it('a sanctioned reading updates owned fields and keeps unrelated lane metadata and root keys', async () => {
    const { dir, overridesFile } = makeRuns({
      compact: { l1_free_gb: 9 },
      zai: { target: 'zai-target', policy: { mode: 'manual' }, note: 'keep-me' },
      claude: {
        weekly_used_pct: 10, credits_remaining: null, reset_at: PAST, source: 'old', estimated: true,
        as_of: PAST, burn_pct_per_hour: null, target: 'claude-target', metadata: { owner: 'fake' },
      },
    });
    const result = await runSelfRefresh({
      runsDir: dir, nowMs: () => T0, lanes: ['claude'],
      readers: { claude: async () => ({ pctUsed: 41, resetAt: FUTURE, limit: 400, creditsRemaining: 236, source: 'fake-reader-222s' }) },
    });

    expect(result.outcomes).toEqual([expect.objectContaining({ lane: 'claude', action: 'read' })]);
    const out = readOverrides(overridesFile);
    expect(out['claude']).toMatchObject({
      weekly_used_pct: 41, credits_remaining: 236, reset_at: FUTURE, source: 'fake-reader-222s',
      estimated: false, as_of: new Date(T0).toISOString(), target: 'claude-target', metadata: { owner: 'fake' },
    });
    // Lanes this pass did not touch are byte-identical; root keys survive.
    expect(out['zai']).toEqual({ target: 'zai-target', policy: { mode: 'manual' }, note: 'keep-me' });
    expect(out['compact']).toEqual({ l1_free_gb: 9 });
    // The calibration state was persisted for later estimates.
    const state = JSON.parse(readFileSync(join(dir, 'metrics', 'usage-self.state.json'), 'utf8'));
    expect(state['claude']).toMatchObject({ pctUsed: 41, unitsPerPct: 4 });
  });

  it('a jobs.jsonl-backed estimate reaches the overrides file with estimated:true', async () => {
    const job = JSON.stringify({ event: 'finish', lane: 'zai', ts: '2026-11-10T01:00:00', tokens_in: 100_000, tokens_out: 10_000 });
    const { dir, overridesFile } = makeRuns({ compact: { l1_free_gb: 1 } }, `${job}\nnot json\n`);
    const result = await runSelfRefresh({ runsDir: dir, nowMs: () => T0, lanes: ['zai'], readers: {} });

    expect(result.outcomes).toEqual([expect.objectContaining({ lane: 'zai', action: 'estimated' })]);
    const zai = readOverrides(overridesFile)['zai'];
    expect(zai.estimated).toBe(true);
    expect(zai.weekly_used_pct).toBeGreaterThan(0);
    expect(zai.reset_at).toBe('2026-11-16T00:00:00.000Z');
    expect(readOverrides(overridesFile)['compact']).toEqual({ l1_free_gb: 1 });
  });

  it('the real CLI path (runUsageSelf) writes the same refresh through default readers', async () => {
    // Only --lane zai is exercised: its sanctioned reader reads runsDir/queue/resources.json
    // (absent here, so it falls through to the accounting estimate). No other lane's reader runs.
    const job = JSON.stringify({ event: 'finish', lane: 'zai', ts: new Date().toISOString(), tokens_in: 50_000, tokens_out: 5_000 });
    const { dir, overridesFile } = makeRuns({}, `${job}\n`);
    const out = JSON.parse(await runUsageSelf(['--runs-dir', dir, '--lane', 'zai']));

    expect(out.dryRun).toBe(false);
    expect(out.lanes).toEqual([expect.objectContaining({ lane: 'zai', action: 'estimated', estimated: true })]);
    expect(readOverrides(overridesFile)['zai']).toMatchObject({ estimated: true, source: 'estimate:phantom-accounting+zai-schedule' });
  });
});

describe('unreadable or expired quota remains unknown (current corrections preserved)', () => {
  it('a lane with no reader and no estimate writes nulls that the autopilot reads as unknown', async () => {
    const { dir, overridesFile } = makeRuns({});
    const result = await runSelfRefresh({ runsDir: dir, nowMs: () => T0, lanes: ['gemini'], readers: {} });

    expect(result.outcomes).toEqual([expect.objectContaining({ lane: 'gemini', action: 'unknown' })]);
    const entry = readOverrides(overridesFile)['gemini'];
    expect(entry.weekly_used_pct).toBeNull();
    expect(entry.reset_at).toBeNull();
    // This is exactly what src/cli/resource-autopilot.ts feeds to decideLanes.
    expect(budgetEntryQuota(entry, T0).value).toBeNull();
  });

  it('a reader that throws cannot fabricate a reading; the lane stays unknown', async () => {
    const { dir, overridesFile } = makeRuns({});
    const result = await runSelfRefresh({
      runsDir: dir, nowMs: () => T0, lanes: ['claude'],
      readers: { claude: async () => { throw new Error('fake-reader-down'); } },
    });
    // No calibration state exists, so there is no honest estimate either.
    expect(result.outcomes[0]!.action).toBe('unknown');
    expect(budgetEntryQuota(readOverrides(overridesFile)['claude'], T0).value).toBeNull();
  });

  it('budgetEntryQuota rejects expired, stale and malformed entries instead of inventing allowance', () => {
    const fresh = { weekly_used_pct: 55, as_of: new Date(T0 - 60_000).toISOString(), reset_at: FUTURE };
    expect(budgetEntryQuota(fresh, T0).value).toEqual({ usedPercent: 55 });
    // Original #4934 rolled a passed reset forward; current master correctly reports unknown.
    const expiredReset = { ...fresh, reset_at: PAST };
    expect(budgetEntryQuota(expiredReset, T0).value).toBeNull();
    const stale = { ...fresh, as_of: new Date(T0 - 3_700_000).toISOString() };
    expect(budgetEntryQuota(stale, T0).value).toBeNull();
    expect(budgetEntryQuota(null, T0).value).toBeNull();
    expect(budgetEntryQuota({ weekly_used_pct: null, as_of: fresh.as_of }, T0).value).toBeNull();
    expect(budgetEntryQuota({ weekly_used_pct: 55, as_of: 'not-a-date' }, T0).value).toBeNull();
  });

  it('estimateLane refuses to estimate past a known reset (no synthetic post-reset allowance)', () => {
    const state: LaneState = { asOf: PAST, pctUsed: 90, resetAt: PAST, unitsPerPct: 100_000, limit: null };
    expect(estimateLane('claude', state, [], T0)).toBeNull();
    // Within the window the same calibration still estimates honestly.
    const live: LaneState = { ...state, resetAt: FUTURE };
    const est = estimateLane('claude', live, [], T0);
    expect(est).toMatchObject({ estimated: true, weekly_used_pct: 90, reset_at: FUTURE });
  });
});
