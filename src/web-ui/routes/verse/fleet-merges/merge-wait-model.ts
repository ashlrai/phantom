/** Pure model for the "Where PRs wait" card. Reads the merge-latency response;
 * a stage that is not known stays null ("unknown"), never 0. */

export type WaitStageKey = 'queue' | 'checks' | 'merge';
export interface WaitStage { key: WaitStageKey; label: string; medianS: number | null; slowestS: number | null; known: number; total: number }
export interface RetryRow { key: string; label: string; href: string | null; detail: string }
export interface MergeWaitView {
  ledger: 'present' | 'missing';
  stages: WaitStage[];
  verdict: string | null;
  retryable: RetryRow[];
  needsPerson: RetryRow[];
}

interface Stages { repo: string; pr: number; queue_wait_s: number | null; required_checks_s: number | null; merge_s: number | null }
const FIELDS: ReadonlyArray<readonly [WaitStageKey, string, keyof Stages, string]> = [
  ['queue', 'Queue', 'queue_wait_s', 'Queue wait is'],
  ['checks', 'Checks', 'required_checks_s', 'Checks are'],
  ['merge', 'Merge', 'merge_s', 'Merge is'],
];
const REASONS: Record<string, string> = {
  unattributed: 'no queue blocker recorded',
  'already-requested': 'retry already requested',
};
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_ROWS = 5;

const rec = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

export function formatWait(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function prRef(row: Record<string, unknown>): { label: string; href: string | null } | null {
  const pr = row.pr;
  if (typeof row.repo !== 'string' || typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return null;
  const href = REPO_RE.test(row.repo) ? `https://github.com/${row.repo}/pull/${pr}` : null;
  return { label: `${row.repo.slice(0, 120)}#${pr}`, href };
}

function rows(list: unknown, detail: (row: Record<string, unknown>) => string): { rows: RetryRow[]; more: number } {
  const out: RetryRow[] = [];
  const all = Array.isArray(list) ? list : [];
  for (const item of all) {
    const row = rec(item), ref = row && prRef(row);
    if (row && ref) out.push({ key: ref.label, ...ref, detail: detail(row) });
  }
  return { rows: out.slice(0, MAX_ROWS), more: Math.max(0, out.length - MAX_ROWS) };
}

/** Null when the response is not the expected shape. */
export function mergeWaitView(raw: unknown): MergeWaitView | null {
  const body = rec(raw), report = rec(body?.report);
  if (!body || body.schema !== 'verse.merge-latency.v1' || !report) return null;
  const ledger = body.ledger === 'present' ? 'present' : 'missing';
  const prs = (Array.isArray(report.pr_stages) ? report.pr_stages : []).map(rec).filter((r): r is Record<string, unknown> => r !== null);
  const stages: WaitStage[] = FIELDS.map(([key, label, field]) => {
    const known = prs.map(r => num(r[field])).filter((v): v is number => v !== null);
    return { key, label, medianS: median(known), slowestS: known.length ? Math.max(...known) : null, known: known.length, total: prs.length };
  });
  // The dominant stage needs all three medians and a unique maximum.
  let verdict: string | null = null;
  if (stages.every(s => s.medianS !== null)) {
    const top = Math.max(...stages.map(s => s.medianS!));
    const winners = stages.filter(s => s.medianS === top);
    if (winners.length === 1) {
      const phrase = FIELDS.find(f => f[0] === winners[0]!.key)![3];
      const hours = num(report.window_hours);
      verdict = `${phrase} the longest wait ${hours === 24 || hours === null ? 'today' : `in the last ${hours}h`}`;
    }
  }
  const retries = rec(report.queue_retries);
  const left = rows(retries?.retryable, r => {
    const waiting = num(r.waiting_s), n = num(r.retries_left);
    return `waiting ${formatWait(waiting)}, ${n === null ? 'unknown' : n} ${n === 1 ? 'retry' : 'retries'} left`;
  });
  const person = rows(retries?.needs_person, r => {
    const used = num(r.retries_used);
    return typeof r.reason === 'string' && REASONS[r.reason] ? REASONS[r.reason]! : r.reason === 'too-many-retries' && used !== null ? `${used} retries used` : 'needs a person to look';
  });
  const more = (n: number): RetryRow[] => n ? [{ key: '+more', label: `+${n} more`, href: null, detail: '' }] : [];
  return { ledger, stages, verdict, retryable: [...left.rows, ...more(left.more)], needsPerson: [...person.rows, ...more(person.more)] };
}
