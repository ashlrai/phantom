/**
 * Second reader for RESULT receipts: a VERIFIED return with `evidenceKind: 'pr'`
 * is the returning agent's word until GitHub agrees. This module re-reads each
 * named pull request through `gh api` and labels it — merged at the claimed
 * head, merged at another head, still open, closed unmerged, or unknown.
 * Read-only and authority-free: the verdict never merges, comments or writes
 * the ledger, and an unreachable GitHub degrades to `unknown`, never a guess.
 */
import { assertRepo, defaultGh, type Gh } from '../autopilot/github.js';

export type ReturnPrVerdict = 'merged-at-head' | 'merged-other-head' | 'open' | 'closed-unmerged' | 'unknown';

/** Minimal receipt shape; the coordination-returns projection is a superset. */
export interface ReturnEvidenceRow {
  claimId: string;
  repo: string;
  result: string;
  evidenceKind: string;
  pr: number | null;
  head: string | null;
}

export interface ReturnPrChecked {
  claimId: string;
  repo: string;
  pr: number;
  head: string | null;
  verdict: ReturnPrVerdict;
  /** Full head oid GitHub reports; null when unread. */
  observedHead: string | null;
  mergedAt: string | null;
  /** Fixed code for unknown verdicts; never raw gh or parser error text. */
  reason?: string;
}

export interface ReturnPrCheckReport {
  v: 1;
  /** Observations grant no execution, merge or spend authority. */
  authority: 'none';
  asOf: string;
  checked: ReturnPrChecked[];
  /** Input rows with no check row of their own: filtered, deduped or truncated. */
  skipped: number;
  /** More distinct eligible repo#pr/head evidence existed than the limit allowed. */
  truncated: boolean;
}

export const RETURN_PR_CHECK_DEFAULT_LIMIT = 20;
export const RETURN_PR_CHECK_MAX_LIMIT = 50;
export const RETURN_PR_CHECK_TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Claimed short head must prefix-match the observed oid: 7+ chars, case-insensitive. */
function headMatches(claimed: string | null, observed: string): boolean {
  if (claimed === null || claimed.length < 7) return false;
  return observed.toLowerCase().startsWith(claimed.toLowerCase());
}

async function checkOne(gh: Gh, row: { claimId: string; repo: string; pr: number; head: string | null }): Promise<ReturnPrChecked> {
  const base = { claimId: row.claimId, repo: row.repo, pr: row.pr, head: row.head };
  let repo: string;
  try { repo = assertRepo(row.repo); } catch {
    return { ...base, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'invalid-repo' };
  }
  let raw: Json;
  try {
    raw = obj(JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/pulls/${row.pr}`])));
  } catch {
    return { ...base, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'read-failed' };
  }
  // Identity fields are optional for older injected readers, but a supplied
  // identity must bind this response to the requested pull and base repo.
  const responseBase = raw['base'];
  const baseRepo = obj(responseBase)['repo'];
  const fullName = obj(baseRepo)['full_name'];
  if (('number' in raw && raw['number'] !== row.pr)
    || ('base' in raw && (responseBase === null || typeof responseBase !== 'object' || Array.isArray(responseBase)))
    || ('repo' in obj(responseBase) && (baseRepo === null || typeof baseRepo !== 'object' || Array.isArray(baseRepo)))
    || ('full_name' in obj(baseRepo) && (typeof fullName !== 'string' || fullName.toLowerCase() !== repo.toLowerCase()))) {
    return { ...base, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'invalid-response-identity' };
  }
  const head = obj(raw['head']);
  const observedHead = str(head['sha']);
  const mergedAt = str(raw['merged_at']);
  const validHead = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]+$/i.test(value);
  const timestamp = raw['merged_at'];
  const invalidTimestamp = timestamp !== undefined && timestamp !== null
    && (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)
      || !Number.isFinite(Date.parse(timestamp))
      || new Date(timestamp).toISOString().slice(0, 19) !== timestamp.slice(0, 19));
  const invalidResponse = invalidTimestamp
    || (row.head !== null && !validHead(row.head))
    || ('head' in raw && (raw['head'] === null || typeof raw['head'] !== 'object' || Array.isArray(raw['head'])))
    || ('sha' in head && (typeof head['sha'] !== 'string' || !/^[a-f0-9]{40}$/i.test(head['sha'])))
    || ('merged' in raw && typeof raw['merged'] !== 'boolean')
    || ('state' in raw && raw['state'] !== 'open' && raw['state'] !== 'closed')
    || (raw['merged'] === false && mergedAt !== null)
    || (raw['merged'] === true && timestamp === null)
    || (raw['state'] === 'open' && (raw['merged'] === true || mergedAt !== null));
  if (invalidResponse) {
    return { ...base, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'invalid-response-evidence' };
  }
  const merged = raw['merged'] === true || mergedAt !== null;
  if (merged) {
    if (observedHead === null) return { ...base, verdict: 'unknown', observedHead, mergedAt, reason: 'unparseable' };
    return { ...base, verdict: headMatches(row.head, observedHead) ? 'merged-at-head' : 'merged-other-head', observedHead, mergedAt };
  }
  if (raw['state'] === 'open') return { ...base, verdict: 'open', observedHead, mergedAt };
  if (raw['state'] === 'closed') return { ...base, verdict: 'closed-unmerged', observedHead, mergedAt };
  return { ...base, verdict: 'unknown', observedHead, mergedAt, reason: 'unparseable' };
}

/**
 * Check each eligible receipt once against GitHub. Only VERIFIED rows with
 * `evidenceKind: 'pr'` qualify; calls run one at a time and stop at the total
 * deadline — rows not reached stay listed as `unknown` with reason
 * `deadline`. Rows past `limit` are dropped and reported via `truncated`.
 */
export async function checkReturnPrs(
  rows: readonly ReturnEvidenceRow[],
  opts: { gh?: Gh; now?: () => number; limit?: number; timeoutMs?: number } = {},
): Promise<ReturnPrCheckReport> {
  const gh = opts.gh ?? defaultGh;
  const now = opts.now ?? Date.now;
  const limit = opts.limit !== undefined && Number.isSafeInteger(opts.limit) && opts.limit >= 0
    ? Math.min(opts.limit, RETURN_PR_CHECK_MAX_LIMIT) : RETURN_PR_CHECK_DEFAULT_LIMIT;
  const timeoutMs = opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0
    ? opts.timeoutMs : RETURN_PR_CHECK_TIMEOUT_MS;
  const deadline = now() + timeoutMs;

  const seen = new Set<string>();
  const eligible: { claimId: string; repo: string; pr: number; head: string | null }[] = [];
  for (const row of rows) {
    if (row.result !== 'VERIFIED' || row.evidenceKind !== 'pr'
      || typeof row.pr !== 'number' || !Number.isSafeInteger(row.pr) || row.pr < 1) continue;
    // Keep conflicting heads and their original claim provenance independently visible.
    const key = JSON.stringify([row.repo.toLowerCase(), row.pr, row.head?.toLowerCase() ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push({ claimId: row.claimId, repo: row.repo, pr: row.pr, head: row.head });
  }
  const truncated = eligible.length > limit;
  const checked: ReturnPrChecked[] = [];
  let expired = false;
  for (const row of eligible.slice(0, limit)) {
    const remaining = deadline - now();
    if (expired || remaining <= 0) {
      checked.push({ ...row, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'deadline' });
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    const result = await Promise.race([checkOne(gh, row), timeout]).finally(() => clearTimeout(timer));
    if (result === null || now() >= deadline) {
      expired = true;
      checked.push({ ...row, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'deadline' });
    } else {
      checked.push(result);
    }
  }
  const end = now();
  return { v: 1, authority: 'none', asOf: Number.isFinite(end) ? new Date(end).toISOString() : 'unknown', checked,
    skipped: rows.length - checked.length, truncated };
}
