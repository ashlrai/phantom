/**
 * Which PRs were reverted after merging, from both places `phm improve observe`
 * records it: the outcome ledger (registered self-improvement PRs) and cloud
 * tasks (`outcome.revertedBy`). Keys are `prKey(repo, number)`. A ledger
 * outcome counts only while its last observation is a revert, so a re-landed
 * change is not in the set.
 *
 * The other half is the 72h-window revert detector the router reads:
 * `detectRevertOutcomes` / `revertOutcomeRecords` scan a default-branch
 * history for commits that revert a merged PR within `REVERT_WINDOW_MS` of
 * the merge and emit a `RevertOutcomeRecord` per detection — repository, PR
 * key, the merge and revert commits and both times — so routing scores a
 * route on whether its merges HELD, not on the moment-of-merge verdict.
 * A revert commit is recognised by the same rules as observe.ts
 * (`revertsCommitBody`): git's "This reverts commit <sha>" or GitHub's
 * "Reverts owner/repo#n". A merge whose time cannot be established is
 * skipped — unknown, never a window claim.
 */
import { credentialExecFileSync as execFileSync } from '../integrations/secrets.js';
import { listCloudTasks } from '../cloud/store.js';
import type { CloudTaskV1 } from '../cloud/types.js';
import { prKey } from './lesson-trial.js';
import { revertsCommitBody, type ObserveExec } from './observe.js';
import { readLedger, scoreOutcomes, type LedgerRecord } from './outcomes.js';

export function revertedPrKeys(
  tasks: readonly CloudTaskV1[] = listCloudTasks(Number.MAX_SAFE_INTEGER),
  records: readonly LedgerRecord[] = readLedger().records,
): Set<string> {
  const keys = new Set<string>();
  for (const o of scoreOutcomes(records)) if (o.reverted && o.pr) keys.add(prKey(o.pr.repository, o.pr.number));
  for (const t of tasks) if (t.outcome?.revertedBy && t.pr) keys.add(prKey(t.repo, t.pr.number));
  return keys;
}

// ---------------------------------------------------------------------------
// Reverts within 72h of merge — the router's hold-rate signal
// ---------------------------------------------------------------------------

/** A merge counts as reverted-for-routing only when the revert lands this fast. */
export const REVERT_WINDOW_MS = 72 * 60 * 60_000;

/**
 * The `git log --format=` shape `revertOutcomeRecords` parses: commit sha,
 * strict-ISO committer time and body, records separated by \x1e. Committer
 * time keeps merge→revert latency in one clock domain.
 */
export const REVERT_LOG_FORMAT = '%H%x1f%cI%x1f%B%x1e';

const GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const SHA = /^[0-9a-f]{40}$/;
const realExec: ObserveExec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** A merged PR the router watches for a fast revert. */
export interface RevertCandidate {
  /** GitHub `owner/name`. */
  repository: string;
  /** The merged PR's number. */
  number: number;
  /** The merge commit on the default branch. */
  mergeSha: string;
  /**
   * ISO merge time (e.g. GitHub's mergedAt). Fallback for histories that do
   * not contain the merge commit itself (`mergeSha..ref` ranges); when the
   * commit is in the scanned history its own committer time wins.
   */
  mergedAt?: string | null;
}

/** One PR reverted within `REVERT_WINDOW_MS` of merge — the record the router consumes. */
export interface RevertOutcomeRecord {
  repository: string;
  number: number;
  /** `prKey(repository, number)` — the identity the router's reverted set uses. */
  pr: string;
  mergeSha: string;
  /** ISO time of the merge (the merge commit's committer time, else `mergedAt`). */
  mergedAt: string;
  /** The default-branch commit that reverted the merge. */
  revertedBy: string;
  /** ISO committer time of the revert commit. */
  revertedAt: string;
  /** revertedAt − mergedAt. Always ≤ the window; clock skew can make it slightly negative. */
  revertLatencyMs: number;
  /** A later commit reverting `revertedBy` (the change landed again); null while the revert stands. */
  relandedBy: string | null;
}

interface HistoryEntry {
  sha: string;
  /** Parseable strict-ISO committer time; null when absent or unreadable. */
  at: string | null;
  body: string;
}

/** `REVERT_LOG_FORMAT` output → entries, newest first. Entries without a valid sha are dropped. */
function parseRevertHistory(log: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const raw of log.split('\x1e')) {
    const entry = raw.trim();
    if (!entry) continue;
    const first = entry.indexOf('\x1f');
    if (first < 0) continue;
    const sha = entry.slice(0, first);
    const rest = entry.slice(first + 1);
    const second = rest.indexOf('\x1f');
    const at = second < 0 ? '' : rest.slice(0, second);
    const body = second < 0 ? rest : rest.slice(second + 1);
    if (!SHA.test(sha)) continue;
    out.push({ sha, at: at !== '' && Number.isFinite(Date.parse(at)) ? at : null, body });
  }
  return out;
}

/**
 * The revert outcome for one merged PR in `log` (newest-first history in
 * `REVERT_LOG_FORMAT`), or null when it was not reverted inside `windowMs`.
 * When the merge commit appears in `log`, only entries before it (its
 * descendants) can revert it; pass a `mergeSha..ref` range and every entry is
 * already a descendant. A revert with an unreadable time cannot bound the
 * window and does not count.
 */
export function revertOutcomeOf(
  log: string,
  candidate: RevertCandidate,
  opts: { windowMs?: number } = {},
): RevertOutcomeRecord | null {
  const windowMs = opts.windowMs ?? REVERT_WINDOW_MS;
  const entries = parseRevertHistory(log);
  const mergeIndex = entries.findIndex((e) => e.sha === candidate.mergeSha);
  const mergedAt = (mergeIndex >= 0 ? entries[mergeIndex]!.at : null)
    ?? (typeof candidate.mergedAt === 'string' && Number.isFinite(Date.parse(candidate.mergedAt)) ? candidate.mergedAt : null);
  if (mergedAt === null) return null;
  const mergedMs = Date.parse(mergedAt);
  const after = mergeIndex >= 0 ? entries.slice(0, mergeIndex) : entries;
  const revertIndex = after.findIndex((e) => e.at !== null && revertsCommitBody(e.body, candidate.mergeSha, candidate.repository, candidate.number));
  if (revertIndex < 0) return null;
  const revert = after[revertIndex]!;
  const revertedMs = Date.parse(revert.at!);
  const latency = revertedMs - mergedMs;
  if (latency > windowMs) return null;
  const reland = after.slice(0, revertIndex).find((e) => revertsCommitBody(e.body, revert.sha, '', 0));
  return {
    repository: candidate.repository, number: candidate.number, pr: prKey(candidate.repository, candidate.number),
    mergeSha: candidate.mergeSha, mergedAt: new Date(mergedMs).toISOString(), revertedBy: revert.sha,
    revertedAt: new Date(revertedMs).toISOString(), revertLatencyMs: latency, relandedBy: reland?.sha ?? null,
  };
}

/** One `RevertOutcomeRecord` per candidate reverted inside the window, in candidate order. */
export function revertOutcomeRecords(
  log: string,
  candidates: readonly RevertCandidate[],
  opts: { windowMs?: number } = {},
): RevertOutcomeRecord[] {
  const out: RevertOutcomeRecord[] = [];
  for (const candidate of candidates) {
    const record = revertOutcomeOf(log, candidate, opts);
    if (record) out.push(record);
  }
  return out;
}

/** The prKey set of the emitted records — what a router subtracts from its landed work. */
export function revertedOutcomeKeys(records: readonly RevertOutcomeRecord[]): Set<string> {
  return new Set(records.map((r) => r.pr));
}

export interface RevertScan {
  records: RevertOutcomeRecord[];
  errors: string[];
}

/**
 * Detect `candidates`' reverts within the window on `ref` (typically
 * `refs/remotes/origin/<default-branch>`) of the checkout at `repoDir`. One
 * `git log` over the ref covers every merge that is its ancestor; a merge the
 * log does not contain needs the candidate's own `mergedAt` to bound the
 * window. Read-only; the caller fetches.
 */
export function detectRevertOutcomes(
  candidates: readonly RevertCandidate[],
  repoDir: string,
  ref: string,
  exec: ObserveExec = realExec,
  opts: { windowMs?: number } = {},
): RevertScan {
  if (candidates.length === 0) return { records: [], errors: [] };
  try {
    const log = exec('git', [...GIT, 'log', `--format=${REVERT_LOG_FORMAT}`, ref], repoDir);
    return { records: revertOutcomeRecords(log, candidates, opts), errors: [] };
  } catch (err) {
    return { records: [], errors: [`log ${ref}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200)}`] };
  }
}
