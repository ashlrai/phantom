/** Advisory merge estimates. History is read-only; this module grants no merge authority. */
import { openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { credentialSpawnSync } from './integrations/secrets.js';

/** What a queued PR's merge-queue wait is spent on. */
export type MergeWaitCause = 'checks' | 'conflict' | 'position';

/**
 * The one recut request a conflicting PR carries. `key` is the idempotency
 * token: the same conflicting head re-read on a later status pass yields the
 * same key, so a consumer deduping by it sees one request, never two. A new
 * head makes a new key — a conflict resolved by force cannot reuse it.
 */
export interface MergeRecutRequest {
  key: string;
  repo: string;
  number: number;
  headSha: string;
}

export interface MergeEta {
  number: number;
  queuePosition: number | null;
  rangeMinutes: [number, number] | null;
  /** Live-collected wait attribution: checks, a conflict, or queue position. Absent on a bare estimate. */
  waitingOn?: MergeWaitCause | null;
  /** Milliseconds spent in the merge queue (enqueuedAt → now); null when not queued or unreported. */
  waitingMs?: number | null;
  /** The recut request a conflicting PR triggers once; absent or null otherwise. */
  recut?: MergeRecutRequest | null;
}
export interface CheckDuration {
  repo: string;
  name: string;
  durationMs: number;
}

/**
 * Attribute one queued PR's wait to its real cause. A conflict outranks
 * position — the entry cannot merge as it stands — and position outranks
 * checks — the entries ahead land first; the head of the queue waits on the
 * merge-group's required checks. A PR outside the queue has no queue wait to
 * attribute (null).
 */
export function attributeMergeWait(conflicting: boolean, queuePosition: number | null): MergeWaitCause | null {
  if (conflicting) return 'conflict';
  if (queuePosition === null) return null;
  return queuePosition > 1 ? 'position' : 'checks';
}

const RECUT_HEAD_RE = /^[0-9a-f]{7,40}$/i;

/** The recut request for one conflicting PR; null when the head is not trustworthy enough to key. */
export function recutRequest(repo: string, number: number, headSha: string | null): MergeRecutRequest | null {
  if (!Number.isSafeInteger(number) || number < 1 || headSha === null || !RECUT_HEAD_RE.test(headSha)) return null;
  const short = repo.split('/').pop() ?? repo;
  const sha = headSha.toLowerCase();
  return { key: `RQ-RECUT-${short}-${number}-${sha.slice(0, 7)}`, repo, number, headSha: sha };
}

/** Missing, oversized or malformed history means unknown, never a fabricated estimate. */
export function readMergeHistory(path = join(homedir(), '.ashlr', 'merge-check-history.json')): CheckDuration[] {
  try {
    const fd = openSync(path, 'r');
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length: number;
    try { length = readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
    if (length > 1024 * 1024) return [];
    const rows: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!Array.isArray(rows) || rows.length > 10_000) return [];
    return rows.filter((r): r is CheckDuration => r !== null && typeof r === 'object'
      && typeof r.repo === 'string' && typeof r.name === 'string'
      && Number.isFinite(r.durationMs) && r.durationMs > 0 && r.durationMs <= 86_400_000);
  } catch { return []; }
}

/** Parallel required checks use the slowest check; queue slots are conservatively serial. */
export function estimateMergeEta(repo: string, number: number, queuePosition: number | null,
  requiredChecks: readonly string[], history: readonly CheckDuration[]): MergeEta {
  const unknown: MergeEta = { number, queuePosition, rangeMinutes: null };
  if (!Number.isSafeInteger(queuePosition) || queuePosition === null || queuePosition < 1
    || requiredChecks.length === 0) return unknown;
  const ranges = [...new Set(requiredChecks)].map(name => {
    const samples = history.filter(r => r.repo === repo && r.name === name && Number.isFinite(r.durationMs)
      && r.durationMs > 0 && r.durationMs <= 86_400_000).map(r => r.durationMs).sort((a, b) => a - b);
    // Two samples are the minimum evidence for a range.
    return samples.length < 2 ? null : [samples[Math.floor((samples.length - 1) * 0.1)]!,
      samples[Math.ceil((samples.length - 1) * 0.9)]!];
  });
  if (ranges.some(r => r === null)) return unknown;
  const known = ranges as number[][];
  return { number, queuePosition, rangeMinutes: [
    Math.max(1, Math.ceil(Math.max(...known.map(r => r[0]!)) * queuePosition / 60_000)),
    Math.max(1, Math.ceil(Math.max(...known.map(r => r[1]!)) * queuePosition / 60_000)),
  ] };
}

const waitText = (ms: number): string => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1_000))}s` : `${Math.round(ms / 60_000)}m`;

export function formatMergeEta(eta: MergeEta): string {
  const base = `PR #${eta.number}: merge ETA ${eta.rangeMinutes ? `${eta.rangeMinutes[0]}–${eta.rangeMinutes[1]} min` : 'unknown'}`
    + (eta.queuePosition === null ? '' : ` (queue #${eta.queuePosition})`);
  if (eta.waitingOn === undefined) return base;
  const waited = typeof eta.waitingMs === 'number' ? `waiting ${waitText(eta.waitingMs)}` : 'waiting';
  if (eta.recut) return `${base} — ${waited} on a merge conflict; recut ${eta.recut.key} requested`;
  if (eta.waitingOn === 'conflict') return `${base} — ${waited} on a merge conflict`;
  if (eta.waitingOn === 'position') return `${base} — ${waited} on queue position`;
  if (eta.waitingOn === 'checks') return `${base} — ${waited} on checks`;
  return base;
}

type GhRead = (args: string[]) => unknown;
function ghRead(cwd: string, args: string[]): unknown {
  const result = credentialSpawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 4_000, maxBuffer: 1024 * 1024 });
  // gh pr checks returns 8 when checks are pending.
  if (result.error || (result.status !== 0 && result.status !== 8)) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

/** Bounded read-only snapshot: at most ten PRs, no inferred queue ordering. */
export function collectMergeEtas(cwd: string, repo: string, history = readMergeHistory(),
  read: GhRead = args => ghRead(cwd, args), now: () => number = () => Date.now()): MergeEta[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return [];
  const [owner, name] = repo.split('/');
  const deadline = now() + 8_000;
  try {
    const response = read(['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:10,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number headRefOid mergeable mergeStateStatus mergeQueueEntry{position enqueuedAt}}}}}',
      '-f', `owner=${owner}`, '-f', `name=${name}`]) as { data?: { repository?: { pullRequests?: { nodes?: unknown[] } } } } | null;
    const nodes = response?.data?.repository?.pullRequests?.nodes;
    if (!Array.isArray(nodes)) return [];
    const recutKeys = new Set<string>();
    return nodes.slice(0, 10).flatMap(raw => {
      const pr = raw as { number?: number; headRefOid?: unknown; mergeable?: unknown; mergeStateStatus?: unknown;
        mergeQueueEntry?: { position?: number; enqueuedAt?: string } | null } | null;
      if (!pr || !Number.isSafeInteger(pr.number) || pr.number! < 1) return [];
      const position = pr.mergeQueueEntry?.position;
      const queuePosition = Number.isSafeInteger(position) && position! > 0 ? position! : null;
      const conflicting = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';
      const enqueuedAt = typeof pr.mergeQueueEntry?.enqueuedAt === 'string' ? Date.parse(pr.mergeQueueEntry.enqueuedAt) : NaN;
      const waitingMs = queuePosition !== null && Number.isFinite(enqueuedAt) ? Math.max(0, now() - enqueuedAt) : null;
      const waitingOn = attributeMergeWait(conflicting, queuePosition);
      let recut: MergeRecutRequest | null = null;
      if (conflicting) {
        const request = recutRequest(repo, pr.number!, typeof pr.headRefOid === 'string' ? pr.headRefOid : null);
        if (request !== null && !recutKeys.has(request.key)) {
          recutKeys.add(request.key);
          recut = request;
        }
      }
      // A conflicting entry cannot merge as it stands: its required-check names
      // describe a tree that will not land, so the read and the ETA are skipped.
      const checks = conflicting || queuePosition === null || history.length === 0 || now() >= deadline ? null
        : read(['pr', 'checks', String(pr.number), '--repo', repo, '--required', '--json', 'name,bucket']);
      const names = Array.isArray(checks) && checks.every(c => c && typeof c.name === 'string' && ['pass', 'pending'].includes(c.bucket))
        ? checks.map(c => c.name as string) : [];
      return [{ ...estimateMergeEta(repo, pr.number!, queuePosition, names, history), waitingOn, waitingMs, recut }];
    });
  } catch { return []; }
}
