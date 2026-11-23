import { beforeEach, describe, expect, it, vi } from 'vitest';
import { briefFactsText, composeBrief, gatherBriefFacts, type BriefSources } from '../src/core/comms/leader-brief.js';
import { buildHourShipped, readHourShipped } from '../src/core/fleet/shipped-hour.js';

vi.mock('../src/core/fleet/shipped-hour.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/shipped-hour.js')>(),
  readHourShipped: vi.fn(),
}));

const now = Date.parse('2026-11-09T17:00:00Z');
const base: BriefSources = {
  digest: {
    ledger: async () => [], appliedProposals: () => [], proposalTitle: () => null,
    cloudTasks: () => [], capacity: () => null, memos: () => [],
    fleetTruth: async (s, n) => ({ windowStartMs: s, windowEndMs: n!, merged: [], mergeCountState: 'unavailable', truncated: false, running: null, queued: null }),
  },
  leader: () => null, cloudTasks: () => [], devinTasks: () => [], openQuestion: () => null,
  driveReport: () => null, holds: () => [], autonomy: () => ({ on: true, mode: 'on' }), comms: () => null,
};
const gather = (sources: BriefSources = {}) => gatherBriefFacts(now - 3600000, now, { ...base, ...sources });

beforeEach(() => vi.resetAllMocks());
describe('original last-hour brief source', () => {
  it('awaits an injected headline and renders it once in both public paths', async () => {
    const facts = await gather({ hourLine: async () => 'Last hour: 2 shipped (2 fleet)' });
    expect(facts.hourLine).toBe('Last hour: 2 shipped (2 fleet)');
    for (const text of [composeBrief('instant', facts), briefFactsText(facts)]) {
      expect(text.match(/Last hour: 2 shipped/g)).toHaveLength(1);
      expect(text).toContain('merge count unavailable');
      expect(text).toContain('current credential');
    }
  }, 90000);
  it.each([null, undefined, 'reject'] as const)('omits unavailable injected source: %s', async (value) => {
    const facts = await gather({ hourLine: async () => { if (value === 'reject') throw new Error('unavailable'); return value; } });
    expect(facts.hourLine).toBeNull();
    expect(briefFactsText(facts)).not.toContain('Last hour:');
  }, 90000);
  it('uses the gathering clock and keeps a complete empty hour', async () => {
    vi.mocked(readHourShipped).mockResolvedValue(buildHourShipped([{ repo: 'example/repo', commits: [] }], now));
    const facts = await gather();
    expect(readHourShipped).toHaveBeenCalledWith({ now });
    expect(facts.hourLine).toBe('Nothing shipped in the last hour.');
    expect(briefFactsText(facts)).toContain(facts.hourLine);
  }, 90000);
  it('preserves partial observed headlines and omits unreadable empty reports', async () => {
    const partial = buildHourShipped([null, { repo: 'example/repo', commits: [{ sha: 'abc', mergedAt: new Date(now).toISOString(), subject: 'fleet update (#1)', paths: [] }] }], now);
    partial.headline = 'At least one change shipped (partial read)';
    vi.mocked(readHourShipped).mockResolvedValueOnce(partial).mockResolvedValueOnce(buildHourShipped([null], now)).mockRejectedValueOnce(new Error('read failed'));
    const observed = await gather();
    expect(observed.hourLine).toBe(partial.headline);
    expect(composeBrief('instant', observed)).toContain(partial.headline);
    for (const facts of [await gather(), await gather()]) {
      expect(facts.hourLine).toBeNull();
      expect(briefFactsText(facts)).not.toContain('Nothing shipped in the last hour');
    }
  }, 90000);
});
