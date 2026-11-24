/**
 * Grouped digest of EMPTY jobs by plain reason (RQ-EMPTYDIGESTN22OQ8). Reuses the single-job classifier
 * in empty-final-reason.ts and adds two publish-note reasons it cannot see in a log. Pure: callers read
 * the files. Anything unrecognised lands in "other" with its first log line, redacted, never dropped.
 */
import { scrubSecrets } from '../util/scrub.js';
import { classifyFinalEmpty, FINAL_EMPTY_LOG_LINES, type FinalEmptyReason } from './empty-final-reason.js';

export const EMPTY_DIGEST_SCHEMA = 'jobs.empty-digest.v1';
export const EMPTY_DIGEST_EXAMPLES = 2;
const QUOTE_MAX = 160;

export type EmptyDigestReason = Exclude<FinalEmptyReason, 'unknown'> | 'secret-shape gate' | 'no gh on this lane' | 'other';

const LABELS: Record<Exclude<FinalEmptyReason, 'unknown'>, string> = {
  'already-shipped': 'already on master', 'no-change-needed': 'no change needed', 'repo-rule': 'blocked by a repo rule',
  'blocked-dependency': 'waiting on another job', 'tool-missing': 'tool or file missing', 'usage-out': 'usage limit',
  'sign-in-failed': 'sign-in failed', 'lane-held': 'lane held', timeout: 'timed out',
};

// Publish notes name these two stops; checked first because a log tail rarely does.
const PUBLISH_RULES: ReadonlyArray<readonly [EmptyDigestReason, RegExp]> = [
  ['secret-shape gate', /secret[- ]?shape/i],
  ['no gh on this lane', /\bno gh\b|\bgh\b[^\n]{0,30}\b(?:missing|not found|unavailable|not installed)\b/i],
];

export interface EmptyDigestInput { id: string; lane: string; log: string | null; publish: string | null }
export interface EmptyDigestRow {
  reason: string;
  count: number;
  lanes: { lane: string; count: number }[];
  /** Newest first, at most two. */
  examples: string[];
  /** Only for "other": the first log line, redacted. */
  firstLine?: string;
}
export interface EmptyDigest { schema: typeof EMPTY_DIGEST_SCHEMA; total: number; reasons: EmptyDigestRow[]; lanes: { lane: string; count: number; reasons: { reason: string; count: number }[] }[] }

const tail = (text: string | null): string[] => (text ?? '').split(/\r?\n/).slice(-FINAL_EMPTY_LOG_LINES);

/** First non-empty line of the final log window, redacted and shortened. */
export function firstLogLine(log: string | null): string | null {
  const line = tail(log).map(l => l.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line) return null;
  return scrubSecrets(line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1)}…` : line);
}

/** One reason per job, in plain words. */
export function classifyDigestReason(log: string | null, publish: string | null): { reason: string; code: EmptyDigestReason } {
  const note = tail(publish).join('\n');
  const rule = PUBLISH_RULES.find(([, re]) => re.test(note));
  if (rule) return { reason: rule[0], code: rule[0] };
  for (const text of [log, publish]) {
    const verdict = classifyFinalEmpty(text);
    if (verdict.reason !== 'unknown') return { reason: LABELS[verdict.reason], code: verdict.reason };
  }
  return { reason: 'other', code: 'other' };
}

const bump = (map: Map<string, number>, key: string): void => void map.set(key, (map.get(key) ?? 0) + 1);
const byCount = (a: { count: number }, b: { count: number }, an: string, bn: string): number => b.count - a.count || an.localeCompare(bn);

/** `jobs` oldest first (ledger order). Biggest reason first. `quote: false` leaves log text out, like the final-reason report. */
export function summarizeEmptyDigest(jobs: readonly EmptyDigestInput[], quote = true): EmptyDigest {
  type Row = { lanes: Map<string, number>; examples: string[]; firstLine?: string; count: number };
  const rows = new Map<string, Row>();
  const laneRows = new Map<string, Map<string, number>>();
  for (const job of [...jobs].reverse()) {
    const { reason } = classifyDigestReason(job.log, job.publish);
    const row: Row = rows.get(reason) ?? { lanes: new Map(), examples: [], count: 0 };
    rows.set(reason, row);
    row.count++;
    bump(row.lanes, job.lane);
    if (row.examples.length < EMPTY_DIGEST_EXAMPLES) row.examples.push(scrubSecrets(job.id));
    if (quote && reason === 'other' && row.firstLine === undefined) row.firstLine = firstLogLine(job.log) ?? '(no log)';
    const lane = laneRows.get(job.lane) ?? new Map();
    laneRows.set(job.lane, lane);
    bump(lane, reason);
  }
  const list = <T extends { count: number }>(map: Map<string, number>, make: (k: string, n: number) => T & { key: string }) =>
    [...map].map(([k, n]) => make(k, n)).sort((a, b) => byCount(a, b, a.key, b.key));
  return {
    schema: EMPTY_DIGEST_SCHEMA, total: jobs.length,
    reasons: [...rows].map(([reason, r]) => ({
      reason, count: r.count, examples: r.examples, ...(r.firstLine !== undefined ? { firstLine: r.firstLine } : {}),
      lanes: list(r.lanes, (lane, count) => ({ lane, count, key: lane })).map(({ lane, count }) => ({ lane, count })),
    })).sort((a, b) => byCount(a, b, a.reason, b.reason)),
    lanes: [...laneRows].map(([lane, m]) => ({
      lane, count: [...m.values()].reduce((x, y) => x + y, 0),
      reasons: list(m, (reason, count) => ({ reason, count, key: reason })).map(({ reason, count }) => ({ reason, count })),
    })).sort((a, b) => byCount(a, b, a.lane, b.lane)),
  };
}

/** Plain lines: `already on master: 14 (claude 9, zai 5)`, or per lane with `by === 'lane'`. */
export function formatEmptyDigest(digest: EmptyDigest, by: 'reason' | 'lane', hours: number): string[] {
  if (digest.total === 0) return ['No empty jobs.'];
  const lines = [`${digest.total} empty jobs in the last ${hours} hours`];
  if (by === 'lane') {
    for (const l of digest.lanes) lines.push(`${l.lane}: ${l.count} (${l.reasons.map(r => `${r.reason} ${r.count}`).join(', ')})`);
    return lines;
  }
  for (const r of digest.reasons) {
    lines.push(`${r.reason}: ${r.count} (${r.lanes.map(l => `${l.lane} ${l.count}`).join(', ')}); e.g. ${r.examples.join(', ')}`);
    if (r.firstLine !== undefined) lines.push(`  first log line: "${r.firstLine}"`);
  }
  return lines;
}
