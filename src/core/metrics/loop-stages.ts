/**
 * Where the self-improvement loop waits (RQ-LOOPSTAGESN21OQ8). For every job that finished in the window, the time
 * spent in each stage from idea to release: queued to launched, launched to finished, finished to PR, PR to merged,
 * merged to released. Pure: the ledger text and the release list come in, a typed report comes out.
 *
 * A timestamp the ledger never recorded makes that stage unknown for that job. Unknown is counted, never zero and
 * never guessed from another stage. A merged job with no release cut yet is `pending`, which is not unknown.
 */
import { jobTimelines, percentile, type JobTimeline, type ReleaseRef } from './loop.js';

export const LOOP_STAGES_SCHEMA = 'metrics.loop-stages.v1' as const;
export const LOOP_STAGES_DEFAULT_SINCE_MS = 24 * 3_600_000;
export const LOOP_STAGES_MAX_SINCE_MS = 30 * 24 * 3_600_000;

export const STAGE_NAMES = ['queued_to_launched', 'launched_to_finished', 'finished_to_pr', 'pr_to_merged', 'merged_to_released'] as const;
export type StageName = (typeof STAGE_NAMES)[number];

const WORDS: Record<StageName, string> = {
  queued_to_launched: 'queued to launched', launched_to_finished: 'launched to finished', finished_to_pr: 'finished to PR',
  pr_to_merged: 'PR to merged', merged_to_released: 'merged to released',
};

export interface StageStats {
  stage: StageName;
  /** Jobs with both timestamps in order. */
  known: number;
  /** Jobs missing a timestamp (or with the two out of order). Never counted as zero. */
  unknown: number;
  /** Merged to released only: merged, and no release has been cut since. Not unknown, not yet. */
  pending: number;
  p50_minutes: number | null;
  p90_minutes: number | null;
}
export interface LoopStagesReport {
  schema: typeof LOOP_STAGES_SCHEMA;
  as_of: string;
  since: string;
  /** Jobs with a finish row inside the window. */
  jobs: number;
  stages: StageStats[];
  /** The stage with the largest p50, or null when no stage has a single known sample. */
  slowest: { stage: StageName; p50_minutes: number } | null;
  /** The slowest stage in plain words, or why it is unknown. */
  headline: string;
  /** Whether a release list was available. When false, merged to released is unknown for every job. */
  releases: 'ok' | 'unavailable';
  /** Plain reason merged to released is unknown; null when releases were read. */
  releases_reason: string | null;
  /** True when the jobs ledger tail was cut at the read cap: every stage covers only the newest bytes. Null when the reader did not report truncation. */
  jobs_truncated: boolean | null;
}

/** "24h", "90m", "7d" to milliseconds, within 1 minute to 30 days. Null when invalid. */
export function parseSince(value: string | null | undefined): number | null {
  if (value == null) return LOOP_STAGES_DEFAULT_SINCE_MS;
  const match = /^([1-9]\d{0,5})([mhd])$/.exec(value.trim());
  if (!match) return null;
  const ms = Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  return ms <= LOOP_STAGES_MAX_SINCE_MS ? ms : null;
}

/** "41 min", "30 s" under a minute, "2.5 h" from two hours. */
export function minutesText(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} s`;
  return minutes < 120 ? `${Math.round(minutes)} min` : `${Math.round(minutes / 6) / 10} h`;
}

const gap = (from: number | null, to: number | null): number | null => from === null || to === null || to < from ? null : (to - from) / 60_000;

/**
 * First release containing a merge: the earliest release cut at or after it (squash merges on a linear default
 * branch). Releases are the newest N, so a merge older than the oldest one fetched cannot be placed: unknown.
 */
function releaseGap(job: JobTimeline, releases: readonly ReleaseRef[] | null): { minutes: number | null; pending: boolean } {
  if (job.mergedAt === null || !releases?.length) return { minutes: null, pending: false };
  const sorted = [...releases].sort((a, b) => a.createdAt - b.createdAt);
  if (job.mergedAt < sorted[0]!.createdAt) return { minutes: null, pending: false };
  const first = sorted.find(release => release.createdAt >= job.mergedAt!);
  return first ? { minutes: gap(job.mergedAt, first.createdAt), pending: false } : { minutes: null, pending: true };
}

const round = (n: number): number => Math.round(n * 10) / 10;

export function buildLoopStages(ledger: string | null, releases: readonly ReleaseRef[] | null, now: number, sinceMs = LOOP_STAGES_DEFAULT_SINCE_MS, releasesReason: string | null = null, jobsTruncated?: boolean): LoopStagesReport {
  const finished = [...jobTimelines(ledger, now).values()].filter(job => job.finishedAt !== null && job.finishedAt > now - sinceMs);
  const samples = new Map<StageName, number[]>(STAGE_NAMES.map(name => [name, []]));
  const counts = new Map<StageName, { unknown: number; pending: number }>(STAGE_NAMES.map(name => [name, { unknown: 0, pending: 0 }]));
  for (const job of finished) {
    const rel = releaseGap(job, releases);
    const values: Record<StageName, number | null> = {
      queued_to_launched: gap(job.enqueuedAt, job.launchedAt), launched_to_finished: gap(job.launchedAt, job.finishedAt),
      finished_to_pr: gap(job.finishedAt, job.openedAt), pr_to_merged: gap(job.openedAt, job.mergedAt), merged_to_released: rel.minutes,
    };
    for (const name of STAGE_NAMES) {
      const value = values[name];
      if (value !== null) samples.get(name)!.push(value);
      else if (name === 'merged_to_released' && rel.pending) counts.get(name)!.pending++;
      else counts.get(name)!.unknown++;
    }
  }
  const stages: StageStats[] = STAGE_NAMES.map(stage => {
    const values = samples.get(stage)!;
    const p50 = percentile(values, 0.5), p90 = percentile(values, 0.9);
    return { stage, known: values.length, ...counts.get(stage)!, p50_minutes: p50 === null ? null : round(p50), p90_minutes: p90 === null ? null : round(p90) };
  });
  const timed = stages.filter(s => s.p50_minutes !== null);
  const top = timed.reduce<StageStats | null>((best, s) => !best || s.p50_minutes! > best.p50_minutes! ? s : best, null);
  const slowest = top ? { stage: top.stage, p50_minutes: top.p50_minutes! } : null;
  return {
    schema: LOOP_STAGES_SCHEMA, as_of: new Date(now).toISOString(), since: new Date(now - sinceMs).toISOString(), jobs: finished.length, stages, slowest,
    headline: ledger === null ? 'Biggest wait: unknown (job ledger unreadable)'
      : !finished.length ? 'Biggest wait: unknown (no job finished in this window)'
      : slowest ? `Biggest wait: ${WORDS[slowest.stage]}, p50 ${minutesText(slowest.p50_minutes)}`
      : 'Biggest wait: unknown (no job has two timestamps for any stage)',
    releases: releases?.length ? 'ok' : 'unavailable',
    releases_reason: releases?.length ? null : releasesReason ?? 'No release list was supplied',
    jobs_truncated: jobsTruncated ?? null,
  };
}

/** Plain-words lines for the CLI: the sentence, then one row per stage. */
export function loopStagesText(report: LoopStagesReport): string[] {
  const cell = (minutes: number | null) => minutes === null ? 'unknown' : minutesText(minutes);
  return [
    `${report.headline} (${report.jobs} job${report.jobs === 1 ? '' : 's'} finished since ${report.since}).`,
    ...report.stages.map(s => `${WORDS[s.stage]}: p50 ${cell(s.p50_minutes)}, p90 ${cell(s.p90_minutes)} (${s.known} known, ${s.unknown} unknown${s.pending ? `, ${s.pending} waiting for a release` : ''})`),
    ...(report.jobs_truncated === true ? ['jobs.jsonl tail was cut at the read cap: stage times cover only the newest bytes.'] : []),
    ...(report.releases === 'unavailable' ? [`Merged to released is unknown: ${report.releases_reason ?? 'releases could not be read'}.`] : []),
  ];
}

export const stageWords = (stage: StageName): string => WORDS[stage];
