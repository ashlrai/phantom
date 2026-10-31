import { beforeEach, describe, expect, it, vi } from 'vitest';
import { draftSkillNudges, nudgeSkillsFromJobs, type SkillNudgeJob } from '../src/core/fleet/skill-nudge.js';
import { readSkillCardCorpus, recordSkillCard, sanitizeSkillCard } from '../src/core/fleet/skill-records.js';
import { selectVerifiedSkills } from '../src/core/fleet/skill-retrieval.js';
import { createHash } from 'node:crypto';
import { parseMetricsFeed } from '../src/core/fleet/metrics-ingest.js';
import type { SkillCard } from '../src/core/types.js';

// Exercise the actual record sanitizer without real filesystem I/O.
vi.mock('../src/core/fleet/skill-records.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/skill-records.js')>();
  return { ...actual, readSkillCardCorpus: vi.fn(), recordSkillCard: vi.fn() };
});
const ts = '2026-01-01T00:00:00.000Z';
const job = (id: string, extra: Partial<SkillNudgeJob> = {}): SkillNudgeJob =>
  ({ id, lane: 'typecheck', outcome: 'merged', ...extra });
const repeated = [job('a', { outcome: 'failed', failureClass: 'types' }),
  job('b', { outcome: 'failed', failureClass: 'types' }),
  job('c', { outcome: 'failed', failureClass: 'types' }), job('d', { failureClass: 'types' })];
let cards: SkillCard[];
beforeEach(() => {
  cards = [];
  vi.mocked(readSkillCardCorpus).mockImplementation(() => ({ cards, sourceState: 'healthy', sourcePresent: true,
    filesScanned: 0, unreadableFiles: 0, invalidRows: 0, bytesScanned: 0, limitExceeded: false }));
  vi.mocked(recordSkillCard).mockImplementation(input => { cards.push(...(Array.isArray(input) ? input : [input])); });
});
describe('shadow skill nudges', () => {
  it('produces one bounded recipe for a repeated failure followed by success', () => {
    const [draft] = draftSkillNudges(repeated, ts);
    expect(draft).toMatchObject({ status: 'candidate', trigger: 'typecheck: recover from types', sourceJobIds: ['a', 'b', 'c', 'd'] });
    expect(draft?.steps).toHaveLength(3);
    expect(draftSkillNudges(repeated, ts)).toHaveLength(1);
  });
  it('ignores clean first passes, unresolved failures and reverted successes', () => {
    expect(draftSkillNudges([job('clean'), ...repeated.slice(0, 2)], ts)).toEqual([]);
    expect(draftSkillNudges([job('revert', { retries: 1, reverted: true })], ts)).toEqual([]);
  });
  it('learns from retries and recuts only after success', () => {
    expect(draftSkillNudges([job('retry', { retries: 1 }), job('recut', { recuts: 1 })], ts)).toHaveLength(2);
    expect(draftSkillNudges([job('fail', { outcome: 'failed', retries: 3 })], ts)).toEqual([]);
  });
  it('collapses duplicate observations, drafts and repeated sweeps', () => {
    expect(draftSkillNudges([repeated[0]!, repeated[0]!, repeated[2]!], ts)).toEqual([]);
    expect(nudgeSkillsFromJobs([...repeated, ...repeated], ts)).toHaveLength(1);
    expect(nudgeSkillsFromJobs(repeated, ts)).toEqual([]);
    expect(cards).toHaveLength(1);
  });
  it('keeps candidates outside active retrieval', () => {
    nudgeSkillsFromJobs(repeated, ts);
    expect(selectVerifiedSkills(cards, { title: 'typecheck types recovery' })).toMatchObject({
      consideredCount: 0, eligibleCount: 0, selectedSkillIds: [],
    });
  });
  it('preserves and bounds recipe metadata through the existing sanitizer', () => {
    const draft = draftSkillNudges(repeated, ts)[0]!;
    expect(sanitizeSkillCard(draft)).toEqual(draft);
    const bounded = sanitizeSkillCard({ ...draft, trigger: 'x'.repeat(1000),
      steps: Array.from({ length: 20 }, (_, i) => `${i}-${'x'.repeat(1000)}`), sourceJobIds: Array.from({ length: 20 }, (_, i) => `job-${i}`) });
    expect(bounded.trigger!.length).toBeLessThanOrEqual(480);
    expect(bounded.steps).toHaveLength(16);
    expect(bounded.steps![0]!.length).toBeLessThanOrEqual(480);
    expect(bounded.sourceJobIds).toHaveLength(16);
  });
  it('validates structured recovery measurements in metrics ingestion', () => {
    for (const patch of [{ retries: -1 }, { recuts: 1.5 }, { failureClass: '../raw' }]) {
      const text = JSON.stringify({ schemaVersion: 1, ...job('j'), tier: 'mid', ...patch });
      const status = JSON.stringify({ schemaVersion: 1, jobsSha256: createHash('sha256').update(text).digest('hex'), jobs: [] });
      expect(() => parseMetricsFeed(text, status)).toThrow();
    }
  });
  it('fails closed on degraded history', () => {
    vi.mocked(readSkillCardCorpus).mockReturnValue({ ...readSkillCardCorpus(), sourceState: 'degraded' });
    expect(nudgeSkillsFromJobs(repeated, ts)).toEqual([]);
  });
});
