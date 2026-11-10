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
 * performs the requests. A failed request records nothing and may be retried
 * on a later run.
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
import { PHANTOM_PR_HOLDS } from './fleet-merge-recover.js';

const USAGE = 'Usage: phm fleet merge-retry [--events <file>] [--apply] [--json]\n' +
  'Preview bounded auto-merge retries for transient queue failures recorded in the merge-events ledger. ' +
  'Apply re-arms ordinary head-pinned auto-merge (gh pr merge --auto --match-head-commit); required checks and the merge queue remain enforced. ' +
  `At most ${MAX_QUEUE_RETRIES} retries per PR ever; the ledger dedupes repeats. Dry run without --apply.`;
const SCHEMA = 'fleet.merge-retry.v1';
/** At most this many merge requests per apply run; extras report capped. */
export const MAX_REQUESTS_PER_RUN = 3;
const FIELDS = 'number,state,headRefOid,isDraft,mergeStateStatus,autoMergeRequest';
/** mergeStateStatus values merge-recover also treats as safe to arm auto-merge on. */
const READY_STATES = new Set(['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS']);
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
  /** For needs-person rows: unattributed, already-requested or too-many-retries. */
  reason?: string;
  disabled_at?: string;
  waiting_s?: number;
  retries_left?: number;
  head_sha?: string | null;
}

export interface MergeRetryReport {
  schema: typeof SCHEMA;
  dryRun: boolean;
  ok: boolean;
  known: boolean;
  max_retries_per_pr: number;
  rows: MergeRetryRow[];
}

type RetryRecorder = (event: { repo: string; pr: number; type: 'retry_requested'; at: string; head_sha?: string }) => Promise<void>;

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
      'Default ledger: ~/.ashlr-runs/metrics/merge-events.jsonl. Each apply appends one retry_requested event per requested PR.',
      `Bounds: ${MAX_QUEUE_RETRIES} retries per PR total, ${MAX_REQUESTS_PER_RUN} requests per run. Held PRs are never retried.`,
      'Actions: request-auto-merge (dry run), auto-merge-requested, already-armed, already-requested, conflict, draft, merged, closed, not-ready, held, capped, failed, needs-person.',
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
  if (latency.known) {
    const retries = latency.queue_retries!;
    for (const candidate of retries.retryable) {
      const base = { repo: candidate.repo, pr: candidate.pr, disabled_at: candidate.disabled_at,
        waiting_s: candidate.waiting_s, retries_left: candidate.retries_left, head_sha: candidate.head_sha };
      if (!apply) { rows.push({ ...base, action: 'request-auto-merge' }); continue; }
      const action = attempted >= MAX_REQUESTS_PER_RUN
        ? 'capped'
        : await retryOne(candidate, gh, record, now);
      if (action === 'auto-merge-requested' || action === 'failed') attempted += 1;
      if (action === 'failed') failed = true;
      rows.push({ ...base, action });
    }
    for (const person of retries.needs_person) {
      rows.push({ repo: person.repo, pr: person.pr, action: 'needs-person', reason: person.reason });
    }
  }
  const report: MergeRetryReport = { schema: SCHEMA, dryRun: !apply, ok: latency.known && !failed,
    known: latency.known, max_retries_per_pr: MAX_QUEUE_RETRIES, rows };
  output(json ? JSON.stringify(report)
    : !latency.known ? 'Merge retry: unknown (events unreadable)'
    : rows.length
      ? rows.map(row => `${row.repo}#${row.pr}: ${row.action}${row.reason ? ` (${row.reason})` : ''}`).join('\n')
      : 'No dropped auto-merges to retry.');
  return !latency.known || failed ? 1 : 0;
}

async function retryOne(candidate: RetryableQueueFailure, gh: CloudGh, record: RetryRecorder, now: number): Promise<string> {
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
  try {
    const result = await gh(['pr', 'merge', String(pr), '--repo', repo, '--auto', '--match-head-commit', current.headRefOid]);
    if (!result.ok) return 'failed';
  } catch { return 'failed'; }
  try {
    await record({ repo, pr, type: 'retry_requested', at: new Date(now).toISOString(), head_sha: current.headRefOid });
  } catch { /* the request landed; the next run only loses the dedupe hint */ }
  return 'auto-merge-requested';
}
