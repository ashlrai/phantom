import { describe, expect, it, vi } from 'vitest';
import { staleResources } from '../src/cli/resource-stale.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import type { CodexSessionUsage } from '../src/core/fleet/codex-session-usage.js';

const now = Date.parse('2026-11-09T12:00:00Z');
const lane = (name: string, observedAt: string | null) => ({ lane: name, running: null, target: null, held: null,
  window: 'weekly' as const, usedPct: 20, creditsRemaining: null, resetAt: null, burnPctPerHour: null,
  tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  quotaEvidence: { state: 'unknown' as const, reason: 'no-reading' as const, holdConflict: null, measuredQuota: null,
    statusQuota: { lane: name, window: 'weekly' as const, usedPct: 20, resetAt: null, source: null, observedAt }, maxAgeMs: 300000 } });
const ledger = async (): Promise<ResourceLedgerV1> => ({ v: 1, generatedAt: new Date(now).toISOString(),
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: null, apiSpend: null, jobsMalformedRows: null,
  lanes: [lane('codex-personal', '2026-11-09T09:00:00Z'), lane('claude', null)] });
describe('resource freshness', () => {
  it('flags a three-hour reading and refreshes it, retaining unknown ages', async () => {
    const probe = vi.fn().mockResolvedValue({ observedAt: new Date(now).toISOString(),
      secondary: { usedPercent: 30, windowMinutes: 10080 } } as CodexSessionUsage);
    const result = await staleResources({ now: () => now, ledger, probe });
    expect(result.resources[0]).toMatchObject({ ageMs: 3 * 3600000, stale: true, refresh: 'current', weeklyUsedPct: 30 });
    expect(result.resources[1]).toMatchObject({ ageMs: null, stale: null, refresh: 'not-attempted' });
    expect(probe).toHaveBeenCalledOnce();
  });
  it('reports refresh failure without erasing the stale observation', async () => {
    const result = await staleResources({ now: () => now, ledger, probe: async () => { throw new Error('private'); } });
    expect(result.resources[0]).toMatchObject({ stale: true, refresh: 'failed', refreshedAt: null });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
