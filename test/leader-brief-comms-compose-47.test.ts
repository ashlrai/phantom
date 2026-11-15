import { describe, expect, it } from 'vitest';
import { composeBrief, gatherBriefFacts, type BriefSources } from '../src/core/comms/leader-brief.js';
import type { UnifiedInbox } from '../src/core/comms/unified-inbox.js';

const NOW = Date.parse('2026-11-09T17:00:00.000Z');
const since = NOW - 3_600_000;
// gatherBriefFacts lazily imports the real source modules; a cold transform is slow.
const SLOW = 90_000;

function base(): BriefSources {
  return {
    digest: {
      ledger: async () => [],
      appliedProposals: () => [],
      proposalTitle: () => null,
      cloudTasks: () => [],
      capacity: () => null,
      memos: () => [],
      fleetTruth: async (s, n) => ({ windowStartMs: s, windowEndMs: n!, merged: [], mergeCountState: 'ok', truncated: false, running: null, queued: null }),
    },
    leader: () => null,
    cloudTasks: () => [],
    devinTasks: () => [],
    openQuestion: () => null,
    driveReport: () => null,
    holds: () => [],
    autonomy: () => ({ on: true, mode: 'on' }),
  };
}

const inbox = {
  v: 1,
  generatedAt: new Date(NOW).toISOString(),
  sources: {
    'needs-you': { state: 'healthy', pending: 0 },
    imessage: { state: 'healthy', pending: 1 },
    drafts: { state: 'healthy', pending: 2 },
    bus: { state: 'healthy', pending: 0 },
    gmail: { state: 'healthy', pending: 0 },
  },
  total: 3,
  omitted: 0,
  items: [{ source: 'imessage', since: new Date(NOW - 40 * 60_000).toISOString() }],
} as unknown as UnifiedInbox;

describe('brief comms seam', () => {
  it('composes the Comms line and puts the Dot blocker first', async () => {
    const facts = await gatherBriefFacts(since, NOW, { ...base(), comms: () => inbox });
    const text = composeBrief('instant', facts);
    expect(text).toContain('Comms: 1 Dot text waiting (oldest 40m), 2 drafts to approve');
    expect(text).toMatch(/Blockers: Dot \(Ashlr\.\) waiting 40m on 1 text/);
    expect(text.indexOf('Comms:')).toBeLessThan(text.indexOf('Blockers:'));
  }, SLOW);

  it('a throwing or null comms seam leaves the brief exactly as without one', async () => {
    const without = composeBrief('instant', await gatherBriefFacts(since, NOW, { ...base(), comms: () => null }));
    const thrown = composeBrief('instant', await gatherBriefFacts(since, NOW, { ...base(), comms: () => { throw new Error('boom'); } }));
    const rejected = composeBrief('instant', await gatherBriefFacts(since, NOW, { ...base(), comms: async () => { throw new Error('boom'); } }));
    expect(thrown).toBe(without);
    expect(rejected).toBe(without);
    expect(without).not.toContain('Comms:');
    expect(without).toContain('Blockers: none.');
  }, SLOW);
});
