/** Shared by the server reader and the Verse UI. */
/** Feed kinds in display order. A PR opening and a plain finish are both `finished`; a failed exit is an `incident`. */
export const WORKLOG_KINDS = ['merged', 'launched', 'finished', 'empty', 'leader', 'incident'] as const;
export type WorklogKind = typeof WORKLOG_KINDS[number];
/** One line of the feed. `count` is how many consecutive same-kind events of one job it stands for. */
export interface WorklogRow {
  at: string; kind: WorklogKind; job: string | null; lane: string | null; repo: string | null;
  text: string; url: string | null; count: number;
}
/** A source that could not be read is `unknown` with a fixed reason; its rows are absent, not zero. */
export type WorklogSource = { state: 'ok' } | { state: 'unknown'; reason: string };
export type WorklogSources = Record<'jobs' | 'events' | 'leader', WorklogSource>;
export interface WorklogEntry {
  job: string | null; repo: string | null; lane: string | null; model: string | null;
  kind: 'launch' | 'finished' | 'pr' | 'empty' | 'failed' | 'merged' | 'closed'; at: string;
  mergedAt: string | null; openToMergeSeconds: number | null; url: string | null;
  /** The job's one-line goal (its recorded title), when any joined event carries one. */
  goal: string | null;
  /** Why a job failed or ended with no change, in plain words; null when not recorded. */
  detail: string | null;
}
export interface WorklogReport {
  schema: 'worklog.v3'; hours: number | null; rows: WorklogRow[]; sources: WorklogSources;
  entries: WorklogEntry[]; malformedLines: number;
}
