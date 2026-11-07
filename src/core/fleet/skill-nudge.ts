/** Deterministic shadow learning from structured, chronological job metadata. */
import { createHash } from 'node:crypto';
import type { SkillCard } from '../types.js';
import type { MetricsJob } from './metrics-ingest.js';
import { readSkillCardCorpus, recordSkillCard, sanitizeSkillCard } from './skill-records.js';

export type SkillNudgeJob = Pick<MetricsJob,
  'id' | 'lane' | 'outcome' | 'reverted' | 'retries' | 'recuts' | 'failureClass'>;

const validId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const positiveCount = (value: number | undefined): boolean =>
  value !== undefined && Number.isSafeInteger(value) && value > 0;

/**
 * Input order is oldest first. Duplicate job ids count once; conflicting rows
 * are ignored. A recurring class needs three distinct failed jobs before
 * a successful recovery. Only merged, non-reverted jobs seed drafts.
 */
export function draftSkillNudges(jobs: readonly SkillNudgeJob[], ts: string): SkillCard[] {
  const byId = new Map<string, SkillNudgeJob>();
  const conflicts = new Set<string>();
  for (const job of jobs) {
    if (!validId(job.id) || !validId(job.lane) ||
      (job.failureClass !== undefined && !validId(job.failureClass))) continue;
    const old = byId.get(job.id);
    if (old && JSON.stringify(old) !== JSON.stringify(job)) conflicts.add(job.id);
    else byId.set(job.id, job);
  }
  const seen = new Map<string, string[]>();
  const drafts = new Map<string, SkillCard>();
  for (const job of byId.values()) {
    if (conflicts.has(job.id) || !['merged', 'failed', 'empty', 'cancelled'].includes(job.outcome ?? '')) continue;
    const key = JSON.stringify([job.lane, job.failureClass ?? 'recovery']);
    const sources = seen.get(key) ?? [];
    if (job.failureClass && job.outcome === 'failed') sources.push(job.id);
    seen.set(key, sources);
    if (job.outcome !== 'merged' || job.reverted === true) continue;
    const retry = positiveCount(job.retries), recut = positiveCount(job.recuts);
    if (!retry && !recut && !(job.failureClass && sources.length >= 3)) continue;
    const trigger = job.failureClass
      ? `${job.lane}: recover from ${job.failureClass}`
      : `${job.lane}: recover after ${recut ? 'recut' : 'retry'}`;
    const steps = [
      `Inspect the structured failure classification for ${job.lane}.`,
      `Address ${job.failureClass ?? 'the failed attempt'} before retrying or recutting.`,
      'Run the affected verification and confirm a successful outcome before reuse.',
    ];
    const skillId = `skill.nudge.${createHash('sha256').update(JSON.stringify([trigger, steps])).digest('hex')}`;
    const old = drafts.get(skillId);
    drafts.set(skillId, sanitizeSkillCard({
      schemaVersion: 1, skillId, revision: 1, ts,
      name: 'Draft recovery workflow', summary: trigger,
      status: 'candidate', source: 'imported', tags: ['skill-nudge', 'shadow'],
      trigger, steps,
      sourceJobIds: [...new Set([...(old?.sourceJobIds ?? []), ...sources, job.id])].sort().slice(0, 16),
      verification: { passed: false },
    }));
  }
  return [...drafts.values()].sort((a, b) => a.skillId.localeCompare(b.skillId));
}

/** Append candidates to the existing ledger; never attest or promote them. */
export function nudgeSkillsFromJobs(jobs: readonly SkillNudgeJob[], ts = new Date().toISOString()): SkillCard[] {
  const corpus = readSkillCardCorpus();
  if (corpus.sourceState === 'degraded') return [];
  const existing = new Set(corpus.cards.map(card => card.skillId));
  const drafts = draftSkillNudges(jobs, ts).filter(card => !existing.has(card.skillId));
  recordSkillCard(drafts);
  // The writer is best-effort: report only candidates actually persisted.
  const persisted = new Set(readSkillCardCorpus().cards.map(card => card.skillId));
  return drafts.filter(card => persisted.has(card.skillId));
}
