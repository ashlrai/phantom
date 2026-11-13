/** RQ-PHX-CLAUDEQUOTAREADPRESERVE203S — ledger evidence persistence for the held-Claude
 *  quota reading, preserved from stranded #5214. Fakes only; no provider process is invoked. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeQuotaReading, toClaudeQuotaReading, usableClaudeWeekly, writeClaudeQuotaReading }
  from '../src/core/fleet/claude-quota-reading.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';

const NOW_MS = Date.parse('2026-11-04T12:00:00Z');
const OBSERVED = '2026-11-04T12:00:00.000Z';
const roots: string[] = [];
const setup = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'claude-quota-evidence-'));
  roots.push(root);
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });

const usage = (over: Partial<ClaudeAccountUsageResult>): ClaudeAccountUsageResult => ({
  schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed', reason: 'usage-native-current',
  loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', accountHint: null,
  startedAt: '2026-11-04T12:00:00Z', finishedAt: '2026-11-04T12:00:01Z', windows: [], ...over,
});

describe('claude quota reading evidence persistence', () => {
  it('preserves weekly usedPct and resetAt through a write/read round trip', async () => {
    const root = await setup();
    const reading = toClaudeQuotaReading(usage({
      quotaFresh: true,
      windows: [
        { id: 'seven_day', usedPercent: 61, resetsAt: '2026-11-07T16:02:00Z',
          nativeReport: { source: 'claude-usage-structured', resetDescription: 'prose never persisted' } },
        { id: 'seven_day_fable', usedPercent: 100, resetsAt: '2026-11-07T16:02:00Z' },
        { id: 'five_hour', usedPercent: 3, resetsAt: '2026-11-04T15:00:00Z' },
      ],
    }), OBSERVED);
    expect(reading).toEqual({ v: 1, observedAt: OBSERVED, reason: 'usage-native-current', fresh: true, windows: [
      { id: 'seven_day', usedPct: 61, resetAt: '2026-11-07T16:02:00Z' },
      { id: 'seven_day_fable', usedPct: 100, resetAt: '2026-11-07T16:02:00Z' },
      { id: 'five_hour', usedPct: 3, resetAt: '2026-11-04T15:00:00Z' },
    ] });
    await writeClaudeQuotaReading(root, reading);
    expect(await readClaudeQuotaReading(root)).toEqual(reading);
  });

  it.each([undefined, false])('keeps quotaFresh=%s evidence non-fresh with no windows', async (quotaFresh) => {
    const root = await setup();
    const reading = toClaudeQuotaReading(usage({
      reason: 'usage-output-invalid', quotaFresh,
      windows: [{ id: 'seven_day', usedPercent: 61, resetsAt: '2026-11-07T16:02:00Z' }],
    }), OBSERVED);
    expect(reading).toEqual({ v: 1, observedAt: OBSERVED, reason: 'usage-output-invalid', fresh: false, windows: [] });
    await writeClaudeQuotaReading(root, reading);
    expect(await readClaudeQuotaReading(root)).toEqual(reading);
    expect(await readClaudeQuotaReading(await setup())).toBeNull();
  });

  it('retains a future-dated observedAt verbatim rather than rewriting it as a fresh reset', async () => {
    const root = await setup();
    const future = '2026-11-04T12:01:00.000Z';
    const reading = toClaudeQuotaReading(usage({
      quotaFresh: true,
      windows: [{ id: 'seven_day', usedPercent: 90, resetsAt: null }],
    }), future);
    await writeClaudeQuotaReading(root, reading);
    const back = await readClaudeQuotaReading(root);
    expect(back).toEqual(reading);
    expect(back?.observedAt).toBe(future);
    expect(usableClaudeWeekly(back, NOW_MS)).toBeNull();
  });
});
