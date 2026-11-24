/**
 * Bounded automatic retry for transient merge-queue failures.
 *
 * `phm fleet merge-latency` classifies dropped auto-merges: an open PR whose
 * last timed auto-merge transition is a disable, with `queue` as the newest
 * recorded blocker in that enable→disable episode, is a transient queue
 * failure. This command re-arms those PRs with ordinary GitHub auto-merge —
 * `gh pr merge --auto --match-head-commit <head>` — the same existing
 * auto-merge `phm fleet merge-recover` requests. Required checks, reviews and
 * the merge queue stay in force; nothing is bypassed and no merge is made.
 *
 * Bound: at most MAX_QUEUE_RETRIES distinct retries per PR across the ledger
 * (the merge-latency report counts them), and at most MAX_REQUESTS_PER_RUN
 * merge requests per apply run. Each successful request appends one
 * `retry_requested` event to the same ledger, so a second run sees the retry
 * as already-requested and does nothing. Dry run is the default; `--apply`
 * performs the requests. A failed request appends one `retry_failed` event
 * instead — transient failures retry on a later run without spending a retry,
 * while MAX_QUEUE_RETRIES distinct failed submissions mark the drop
 * `request-failed` and stop automatic retries for good.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultCloudGh } from '../core/cloud/tracker.js';
import {
  MAX_QUEUE_RETRIES,
  fleetMergeLatency,
  recordMergeEvent,
  readMergeEvents,
  type MergeEventReader,
  type RetryableQueueFailure,
} from './fleet-merge-latency.js';
import { parseArmSnapshot, predictArmConflict, type ArmSnapshotRow } from '../core/fleet/merge-arm-conflict.js';
import { PHANTOM_PR_HOLDS } from './fleet-merge-recover.js';

const USAGE = 'Usage: phm fleet merge-retry [--events <file>] [--apply] [--json]\n' +
  'Preview bounded auto-merge retries for transient queue failures recorded in the merge-events ledger. ' +
  'Apply re-arms ordinary head-pinned auto-merge (gh pr merge --auto --match-head-commit); required checks and the merge queue remain enforced. ' +
  `At most ${MAX_QUEUE_RETRIES} retries and ${MAX_QUEUE_RETRIES} distinct failed submissions per PR ever; the ledger dedupes repeats. Dry run without --apply.`;
const SCHEMA = 'fleet.merge-retry.v1';
/** At most this many merge requests per apply run; extras report capped. */
export const MAX_REQUESTS_PER_RUN = 3;
const FIELDS = 'number,state,headRefOid,isDraft,mergeStateStatus,autoMergeRequest';
/** mergeStateStatus values merge-recover also treats as safe to arm auto-merge on. */
const READY_STATES = new Set(['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS']);
const LIST_FIELDS = 'number,isDraft,autoMergeRequest,files';
const HOLD_REPO = 'ashlrai/phantom';

interface LivePr {
  number: number; state: string; headRefOid: string;
  isDraft: boolean; mergeStateStatus: string; autoMergeRequest: unknown;
}

const validLivePr = (value: unknown, pr: number): value is LivePr =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (value as LivePr).number === pr
  && ['OPEN', 'CLOSED', 'MERGED'].includes((value as LivePr).state)
  && /^[0-9a-f]{40}$/i.test((value as LivePr).headRefOid)
  && typeof (value as LivePr).isDraft === 'boolean'
  && typeof (value as LivePr).mergeStateStatus === 'string';

export interface MergeRetryRow {
  repo: string; pr: number; action: string;
  /** For needs-person rows: unattributed, already-requested, too-many-retries or request-failed. */
  reason?: string;
  disabled_at?: string;
  waiting_s?: number;
  retries_left?: number;
  requests_failed?: number;
  head_sha?: string | null;
  /** Plain-words diagnosis and next step for this row. */
  note?: string;
}

/** Queue wait for the PRs this run looked at; merged and closed PRs no longer wait. */
export interface MergeRetryWait {
  /** Rows still waiting on the queue: re-armed, armed, conflicting or stalled. */
  waiting: number;
  /** Longest wait among those rows, from the dropped auto-merge to now; null when none. */
  oldest_s: number | null;
  total_s: number;
  /** Rows whose PR had already merged or closed by the time this ran. */
  finished: number;
  /** Rows that need a recut before any retry can help. */
  conflicts: number;
}

export interface MergeRetryReport {
  schema: typeof SCHEMA;
  dryRun: boolean;
  ok: boolean;
  known: boolean;
  max_retries_per_pr: number;
  queue_wait: MergeRetryWait;
  rows: MergeRetryRow[];
}

const NOTES: Record<string, string> = {
  'request-auto-merge': 'Dropped from the merge queue; --apply re-arms auto-merge.',
  'auto-merge-requested': 'Re-armed auto-merge; it merges when required checks pass.',
  'already-armed': 'Auto-merge is already on again; nothing to do.',
  conflict: 'Merge conflict: retrying cannot help. It needs a recut.',
  'predicted-conflict': 'Shares files with an armed PR that lands first; try again after it merges.',
  draft: 'Draft PR; mark it ready first.',
  merged: 'Already merged; nothing to retry.',
  closed: 'Closed without merging; nothing to retry.',
  'not-ready': 'GitHub is still computing mergeability; the next run retries.',
  held: 'Held PR; never retried automatically.',
  capped: `Over the ${MAX_REQUESTS_PER_RUN} requests per run; the next run retries.`,
  failed: 'GitHub refused or did not answer; the next run retries.',
  'needs-person': 'Automatic retries are used up or the cause is unknown; a person decides.',
};

export function summarizeQueueWait(rows: MergeRetryRow[]): MergeRetryWait {
  const finished = rows.filter(r => r.action === 'merged' || r.action === 'closed').length;
  const open = rows.filter(r => r.waiting_s !== undefined && r.action !== 'merged' && r.action !== 'closed');
  const waits = open.map(r => r.waiting_s!);
  return { waiting: open.length, oldest_s: waits.length ? Math.max(...waits) : null,
    total_s: waits.reduce((a, b) => a + b, 0), finished, conflicts: rows.filter(r => r.action === 'conflict').length };
}

const span = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;

type RetryRecorder = (event: { repo: string; pr: number; type: 'retry_requested' | 'retry_failed'; at: string; head_sha?: string }) => Promise<void>;

export interface MergeRetryDeps {
  gh?: CloudGh;
  read?: MergeEventReader;
  record?: RetryRecorder;
  now?: number;
  output?: (text: string) => void;
}

export async function cmdFleetMergeRetry(args: string[], deps: MergeRetryDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output([
      USAGE,
      'Candidates come from phm fleet merge-latency queue_retries: the dropped auto-merge needs a recorded queue blocker and retries left.',
      'A retry requests plain GitHub auto-merge on the live head; it merges only when required checks and reviews pass on their own.',
      'Default ledger: ~/.ashlr-runs/metrics/merge-events.jsonl. Each apply appends one retry_requested event per requested PR, or one retry_failed event per failed submission.',
      `Bounds: ${MAX_QUEUE_RETRIES} retries and ${MAX_QUEUE_RETRIES} distinct failed submissions per PR total, ${MAX_REQUESTS_PER_RUN} requests per run. Held PRs are never retried.`,
      'Actions: request-auto-merge (dry run), auto-merge-requested, already-armed, already-requested, conflict, predicted-conflict, draft, merged, closed, not-ready, held, capped, failed, needs-person.',
      'Needs-person reasons: unattributed, already-requested, too-many-retries, request-failed.',
      'Every row carries a plain-words note; queue_wait reports how many PRs still wait, the oldest wait, conflicts, and PRs already merged or closed.',
      'Exit: 0 ok, 1 unreadable ledger or a failed request, 2 bad arguments.',
    ].join('\n'));
    return 0;
  }
  let path = join(homedir(), '.ashlr-runs', 'metrics', 'merge-events.jsonl');
  let apply = false, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--events' && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i]!;
    else { output(USAGE); return 2; }
  }
  const now = deps.now ?? Date.now();
  const gh = deps.gh ?? defaultCloudGh;
  const record: RetryRecorder = deps.record ?? (event => recordMergeEvent(path, event));

  const latency = await fleetMergeLatency(deps.read ?? readMergeEvents(path), now);
  const rows: MergeRetryRow[] = [];
  let failed = false, attempted = 0;
  // One open-PR snapshot per repo per run, fetched lazily; unusable stays null (unknown).
  const snapshots = new Map<string, Promise<ArmSnapshotRow[] | null>>();
  const snapshotFor = (repo: string) => {
    let found = snapshots.get(repo);
    if (!found) {
      found = gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '300', '--json', LIST_FIELDS])
        .then(result => (result.ok ? parseArmSnapshot(JSON.parse(result.stdout)) : null))
        .catch(() => null);
      snapshots.set(repo, found);
    }
    return found;
  };
  if (latency.known) {
    const retries = latency.queue_retries!;
    for (const candidate of retries.retryable) {
      const base = { repo: candidate.repo, pr: candidate.pr, disabled_at: candidate.disabled_at,
        waiting_s: candidate.waiting_s, retries_left: candidate.retries_left,
        requests_failed: candidate.requests_failed, head_sha: candidate.head_sha };
      if (!apply) { rows.push({ ...base, action: 'request-auto-merge', note: NOTES['request-auto-merge'] }); continue; }
      const action = attempted >= MAX_REQUESTS_PER_RUN
        ? 'capped'
        : await retryOne(candidate, gh, record, now, snapshotFor);
      if (action === 'auto-merge-requested' || action === 'failed') attempted += 1;
      if (action === 'failed') failed = true;
      rows.push({ ...base, action, note: NOTES[action] });
    }
    for (const person of retries.needs_person) {
      rows.push({ repo: person.repo, pr: person.pr, action: 'needs-person', reason: person.reason, requests_failed: person.requests_failed, note: NOTES['needs-person'] });
    }
  }
  const report: MergeRetryReport = { schema: SCHEMA, dryRun: !apply, ok: latency.known && !failed,
    known: latency.known, max_retries_per_pr: MAX_QUEUE_RETRIES, queue_wait: summarizeQueueWait(rows), rows };
  const wait = report.queue_wait;
  const waitLine = wait.waiting || wait.finished
    ? `Queue wait: ${wait.waiting} waiting${wait.oldest_s === null ? '' : `, oldest ${span(wait.oldest_s)}`}, ${wait.conflicts} conflicting, ${wait.finished} already finished.`
    : '';
  output(json ? JSON.stringify(report)
    : !latency.known ? 'Merge retry: unknown (events unreadable)'
    : rows.length
      ? [...rows.map(row => `${row.repo}#${row.pr}: ${row.action}${row.reason ? ` (${row.reason})` : ''}${row.note ? ` - ${row.note}` : ''}`), waitLine].filter(Boolean).join('\n')
      : 'No dropped auto-merges to retry.');
  return !latency.known || failed ? 1 : 0;
}

async function retryOne(candidate: RetryableQueueFailure, gh: CloudGh, record: RetryRecorder, now: number,
  snapshotFor: (repo: string) => Promise<ArmSnapshotRow[] | null>): Promise<string> {
  const { repo, pr } = candidate;
  if (repo === HOLD_REPO && PHANTOM_PR_HOLDS.has(pr)) return 'held';
  let current: LivePr;
  try {
    const view = await gh(['pr', 'view', String(pr), '--repo', repo, '--json', FIELDS]);
    if (!view.ok) return 'failed';
    const parsed: unknown = JSON.parse(view.stdout);
    if (!validLivePr(parsed, pr)) return 'failed';
    current = parsed;
  } catch { return 'failed'; }
  if (current.state !== 'OPEN') return current.state.toLowerCase();
  if (current.autoMergeRequest) return 'already-armed';
  if (current.isDraft) return 'draft';
  if (current.mergeStateStatus === 'DIRTY') return 'conflict';
  if (!READY_STATES.has(current.mergeStateStatus)) return 'not-ready';
  // Overlap with an already-armed PR means it lands first and this arm would be
  // dropped again; skip without spending a retry. Unknown evidence still arms.
  if (predictArmConflict(pr, await snapshotFor(repo)).state === 'predicted-conflict') return 'predicted-conflict';
  // A failed submission is recorded so a permanently failing PR stops being
  // retried after the bound; a failed state read above records nothing — it
  // was never a submission attempt and retries for free on a later run.
  const submissionFailed = async (): Promise<string> => {
    try {
      await record({ repo, pr, type: 'retry_failed', at: new Date(now).toISOString(), head_sha: current.headRefOid });
    } catch { /* losing the failure record only lets the next run try once more */ }
    return 'failed';
  };
  try {
    const result = await gh(['pr', 'merge', String(pr), '--repo', repo, '--auto', '--match-head-commit', current.headRefOid]);
    if (!result.ok) return submissionFailed();
  } catch { return submissionFailed(); }
  try {
    await record({ repo, pr, type: 'retry_requested', at: new Date(now).toISOString(), head_sha: current.headRefOid });
  } catch { /* the request landed; the next run only loses the dedupe hint */ }
  return 'auto-merge-requested';
}
