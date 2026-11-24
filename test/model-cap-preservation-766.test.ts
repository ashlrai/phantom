import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeCaps, capFromLog, readModelCaps, recordCapFromLog } from '../src/core/fleet/model-caps.js';
import { buildPoolsView, formatPoolsText } from '../src/core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const now = Date.parse('2026-11-20T00:00:00Z');
const reset = '2026-11-20T05:00:00Z';
const log = `You've reached your Fable usage limit. Resets at ${reset}`;

describe('model cap evidence preservation', () => {
  it('persists a model reset and expires it at that instant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-cap-766-'));
    try {
      expect(await recordCapFromLog(dir, log, 'claude', now)).toMatchObject({ model: 'fable', reset_at: reset });
      const caps = await readModelCaps(dir);
      expect(caps).toHaveLength(1);
      expect(activeCaps(caps!, Date.parse(reset) - 1)).toHaveLength(1);
      expect(activeCaps(caps!, Date.parse(reset))).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('ignores plan and unrelated output and respects explicit resets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-cap-766-'));
    try {
      for (const text of ["You've reached your usage limit", 'ordinary output']) {
        expect(await recordCapFromLog(dir, text, 'claude', now)).toBeNull();
      }
      expect(await readModelCaps(dir)).toEqual([]);
      expect(capFromLog(log, 'claude', now, '2026-11-21T00:00:00Z')?.reset_at).toBe('2026-11-21T00:00:00Z');
      for (const value of ['2026-11-20T05:00:00', '2026-02-30T05:00:00Z', '2026-11-20T05:00:00Zjunk']) {
        expect(capFromLog(`You've reached your Fable limit. Resets at ${value}`, 'claude', now)?.reset_at).toBeNull();
      }
      expect(capFromLog("You've reached your Fable limit. Resets at 2026-11-20T05:00:00+02:00", 'claude', now)?.reset_at).toBe('2026-11-20T05:00:00+02:00');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('shows the model cap and independent plan reading with unknowns intact', () => {
    const lane: ResourceLaneRow = { lane: 'claude', running: 1, target: 2, held: false, window: 'weekly', usedPct: 63,
      creditsRemaining: null, resetAt: reset, burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null,
      source: null, deadSignal: null, observation: { source: 'claude-native-usage', asOf: new Date(now).toISOString() } };
    const ledger: ResourceLedgerV1 = { v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: new Date(now).toISOString(), lanes: [lane], apiSpend: null, jobsMalformedRows: null };
    const cap = capFromLog(log, 'claude', now)!;
    const text = formatPoolsText(buildPoolsView(ledger, now, [], [cap]));
    expect(text).toContain('Fable capped since 2026-11-20T00:00:00.000Z (plan at 63%)');
    expect(text).not.toContain('fully used');
    ledger.lanes[0] = { ...lane, usedPct: null };
    expect(formatPoolsText(buildPoolsView(ledger, now, [], [{ ...cap, reset_at: null }]))).toContain('(plan unknown); resets unknown');
  });
});
