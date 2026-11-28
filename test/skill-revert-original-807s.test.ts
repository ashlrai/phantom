/** Preservation contract for PR #8316: synthetic ledger and in-memory cards only. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillCard } from '../src/core/types.js';
import { skillNudgeJobsFromLedger, syncSkillNudgesFromJobsLedger } from '../src/core/fleet/skill-nudge.js';
import { readSkillCardCorpus, recordSkillCard } from '../src/core/fleet/skill-records.js';

vi.mock('../src/core/fleet/skill-records.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/skill-records.js')>(),
  readSkillCardCorpus: vi.fn(), recordSkillCard: vi.fn(),
}));

const url = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const keys = new Set(['ashlrai/phantom#807']);
const ledger = (...rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(row)).join('\n');
const launch = (job: string) => ({ event: 'launch', job, lane: 'codex' });
const verdict = (job: string, state: string, pr = 807) =>
  ({ event: 'outcome', job, lane: 'codex', state, pr_url: url(pr) });
const recovery = (pr = 807) => [launch('RQ-REC'), launch('RQ-REC'), verdict('RQ-REC', 'MERGED', pr)];
const folded = (text: string, evidence?: ReadonlySet<string> | null) =>
  skillNudgeJobsFromLedger(text, evidence).find(job => job.id === 'RQ-REC');

let cards: SkillCard[];
beforeEach(() => {
  cards = [];
  vi.mocked(readSkillCardCorpus).mockImplementation(() => ({ cards, sourceState: 'healthy', sourcePresent: true,
    filesScanned: 0, unreadableFiles: 0, invalidRows: 0, bytesScanned: 0, limitExceeded: false }));
  vi.mocked(recordSkillCard).mockImplementation(input => { cards.push(...(Array.isArray(input) ? input : [input])); });
});

describe('original recovery revert preservation', () => {
  it('withholds a candidate only when the standing merge has an unambiguous reverted PR', async () => {
    const jobsText = ledger(...recovery());
    expect(folded(jobsText, keys)).toMatchObject({ outcome: 'merged', reverted: true });
    const opts = { jobsText, runsDir: '/synthetic', now: () => new Date('2026-11-05T00:00:00Z') };
    expect(await syncSkillNudgesFromJobsLedger({ ...opts, revertedPrKeys: keys })).toMatchObject({ state: 'read', folded: 1, candidates: 0 });
    expect(cards).toHaveLength(0);
    expect(await syncSkillNudgesFromJobsLedger(opts)).toMatchObject({ state: 'read', folded: 1, candidates: 1 });
    expect(cards[0]).toMatchObject({ status: 'candidate', sourceJobIds: ['RQ-REC'] });
  });

  it('preserves existing behavior for absent, null, empty and unmatched evidence', () => {
    const text = ledger(...recovery());
    const baseline = skillNudgeJobsFromLedger(text);
    for (const evidence of [null, new Set<string>(), new Set(['ashlrai/phantom#999'])]) {
      expect(skillNudgeJobsFromLedger(text, evidence)).toEqual(baseline);
    }
    expect(folded(text)).not.toHaveProperty('reverted');
  });

  it('does not resolve contested ownership, but ignores batch and session-pool claimants', () => {
    const other = { event: 'publish', job: 'RQ-OTHER', pr_url: url(807) };
    expect(folded(ledger(...recovery(), other), keys)).not.toHaveProperty('reverted');
    const batch = { event: 'launch', job: 'RQ-BATCH-9', pr_url: url(807) };
    const pool = { schema: 'fleet.session-pool.v1', job: 'sess:1', jobId: 'ready:x', pr_url: url(807) };
    expect(folded(ledger(batch, pool, ...recovery()), keys)).toMatchObject({ outcome: 'merged', reverted: true });
  });

  it('uses the latest verdict PR and never turns a nonmerge into a reverted merge', () => {
    const newer = ledger(...recovery(), verdict('RQ-REC', 'MERGED', 808));
    expect(folded(newer, keys)).toMatchObject({ outcome: 'merged' });
    expect(folded(newer, keys)).not.toHaveProperty('reverted');
    expect(folded(newer, new Set(['ashlrai/phantom#808']))).toMatchObject({ reverted: true });
    for (const [state, outcome] of [['CLOSED', 'failed'], ['DONE-NOOP', 'empty'], ['CANCELLED', 'cancelled']]) {
      const job = folded(ledger(...recovery(), verdict('RQ-REC', state!)), keys);
      expect(job).toMatchObject({ outcome });
      expect(job).not.toHaveProperty('reverted');
    }
  });
});
