import type { CloudGh } from '../cloud/pr-actions.js';
import type { QueueLatencyInput, QueueLatencyPr, QueueStage } from './queue-latency.js';

/** The seven repos the live view reads when `--repos` is not given. */
export const LIVE_QUEUE_REPOS: readonly string[] = [
  'phantom', 'phantom-secrets', 'ashlr-plugin', 'ashlr-stack', 'locus', 'lexicon', 'ashlr-md',
].map(name => `ashlrai/${name}`);

const LIVE_FIELDS = 'number,state,isDraft,createdAt,updatedAt,headRefOid,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup';
const LIST_LIMIT = 200;

export interface LiveQueueCounts { open: number; waitingOnChecks: number; conflicting: number; behind: number }
export interface LiveQueueRead {
  snapshot: QueueLatencyInput;
  counts: LiveQueueCounts;
  /** Open conflicting PRs with their pinned heads, for the merge-recover planner. */
  conflicts: { repo: string; number: number; head: string }[];
  /** Repos GitHub could not be read for; their PRs are missing from every count. */
  unread: string[];
}

interface RawPr {
  number?: unknown; state?: unknown; isDraft?: unknown; createdAt?: unknown; updatedAt?: unknown; headRefOid?: unknown;
  mergeable?: unknown; mergeStateStatus?: unknown; reviewDecision?: unknown;
  autoMergeRequest?: { enabledAt?: unknown } | null;
  statusCheckRollup?: { status?: unknown; startedAt?: unknown }[] | null;
}

const time = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;

/** Accepts `phantom` or `owner/phantom`; returns null for anything else. */
export function parseLiveRepos(list: string): string[] | null {
  const repos = list.split(',').map(r => r.trim()).filter(Boolean).map(r => r.includes('/') ? r : `ashlrai/${r}`);
  return repos.length && repos.every(r => /^[\w.-]+\/[\w.-]+$/.test(r)) ? [...new Set(repos)] : null;
}

/** Turns one recorded or live `gh pr list --json` row into a snapshot row; merged, closed and malformed rows are skipped. */
function toRow(repo: string, raw: RawPr): { pr: QueueLatencyPr; kind: 'conflicting' | 'behind' | 'checks' | 'other' } | null {
  const opened = time(raw.createdAt);
  if (raw.state !== 'OPEN' || !Number.isSafeInteger(raw.number) || (raw.number as number) < 1 || !opened) return null;
  const stages: { stage: QueueStage; at: string }[] = [{ stage: 'opened', at: opened }];
  const approved = raw.reviewDecision === 'APPROVED' ? time(raw.updatedAt) : null;
  if (approved) stages.push({ stage: 'approved', at: approved });
  const queued = time(raw.autoMergeRequest?.enabledAt);
  if (queued) stages.push({ stage: 'queued', at: queued });
  const checks = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [];
  const started = checks.map(c => time(c?.startedAt)).filter((t): t is string => !!t).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (started) stages.push({ stage: 'checks_started', at: started });
  const state = typeof raw.mergeStateStatus === 'string' ? raw.mergeStateStatus : '';
  const conflicting = raw.mergeable === 'CONFLICTING' || state === 'DIRTY';
  const pr: QueueLatencyPr = { repo, number: raw.number as number, stages,
    mergeable: conflicting ? 'CONFLICTING' : raw.mergeable === 'MERGEABLE' ? 'MERGEABLE' : 'UNKNOWN' };
  if (typeof raw.headRefOid === 'string' && /^[a-f0-9]{40}$/.test(raw.headRefOid)) pr.headSha = raw.headRefOid;
  const pending = checks.some(c => c?.status && c.status !== 'COMPLETED');
  const kind = conflicting ? 'conflicting' : state === 'BEHIND' ? 'behind'
    : pending || state === 'BLOCKED' || state === 'UNSTABLE' ? 'checks' : 'other';
  return { pr, kind };
}

/** Reads open PR state through the shared GitHub reader; one failed repo never hides the others. */
export async function collectLiveQueue(gh: CloudGh, repos: readonly string[] = LIVE_QUEUE_REPOS): Promise<LiveQueueRead> {
  const read: LiveQueueRead = { snapshot: { prs: [] }, counts: { open: 0, waitingOnChecks: 0, conflicting: 0, behind: 0 }, conflicts: [], unread: [] };
  for (const repo of repos) {
    let rows: unknown;
    try {
      const result = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', LIVE_FIELDS]);
      if (!result.ok) throw new Error('read');
      rows = JSON.parse(result.stdout);
    } catch { read.unread.push(repo); continue; }
    if (!Array.isArray(rows)) { read.unread.push(repo); continue; }
    for (const raw of rows as RawPr[]) {
      const row = raw && typeof raw === 'object' ? toRow(repo, raw) : null;
      if (!row) continue;
      read.snapshot.prs.push(row.pr);
      read.counts.open++;
      if (row.kind === 'checks') read.counts.waitingOnChecks++;
      else if (row.kind === 'behind') read.counts.behind++;
      else if (row.kind === 'conflicting') {
        read.counts.conflicting++;
        if (row.pr.headSha) read.conflicts.push({ repo, number: row.pr.number, head: row.pr.headSha });
      }
    }
  }
  return read;
}

/** The one-line summary, e.g. "41 open PRs: 30 waiting on checks, 8 conflicting (8 recuts planned), 3 behind". */
export function liveQueueSummary(counts: LiveQueueCounts, recutsPlanned: number): string {
  return `${counts.open} open PR${counts.open === 1 ? '' : 's'}: ${counts.waitingOnChecks} waiting on checks, `
    + `${counts.conflicting} conflicting (${recutsPlanned} recut${recutsPlanned === 1 ? '' : 's'} planned), ${counts.behind} behind`;
}
