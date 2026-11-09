import { describe, expect, it } from 'vitest';
import { leaderDailyBrief } from '../src/core/comms/leader-daily-brief.js';
import { projectPoolBudgets } from '../src/core/fleet/pool-budget.js';
import type { BriefFacts } from '../src/core/comms/leader-brief.js';

const now = new Date('2026-11-03T12:30:00Z');
const facts: BriefFacts = { nowMs: +now, sinceMs: +now - 12 * 3600_000, shipped: [{ text: 'merged feature' }], prsOpened: 0, running: [], blockers: [], next: [], question: null, pendingActionIds: [] };
describe('leader daily brief', () => {
  it('combines recorded shipping, owner-only blockers, quota and pending proposals', async () => {
    const text = await leaderDailyBrief('/unused', now, {
      facts: async () => facts,
      needs: () => ({ status: 'available', items: [{ text: '2FA required' }, { text: 'review a PR' }] }),
      budgets: async () => projectPoolBudgets([{ pool: 'claude', bucket: 'weeklyPct', remaining: 42, timestamp: '2026-11-03T12:00:00.000Z', resetAt: null, source: 'manual' }], now),
      proposals: () => ({ complete: true, proposals: [{ id: 'p-1', title: 'Improve routing' }] }),
    });
    expect(text).toContain('merged feature');
    expect(text).toContain('2FA required');
    expect(text).not.toContain('review a PR');
    expect(text).toContain('claude weeklyPct=42% (held)');
    expect(text).toContain('Improve routing [p-1]');
  });
  it('reports unavailable sources without claiming empty results', async () => {
    const fail = () => { throw new Error('offline'); };
    const text = await leaderDailyBrief('/unused', now, { facts: fail, needs: fail, budgets: fail, proposals: fail });
    expect(text.match(/unavailable/g)).toHaveLength(4);
  });
});
