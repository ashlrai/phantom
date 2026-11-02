/** Advisory merge estimates. History is read-only; this module grants no merge authority. */
import { openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { credentialSpawnSync } from './integrations/secrets.js';

export interface MergeEta {
  number: number;
  queuePosition: number | null;
  rangeMinutes: [number, number] | null;
}
export interface CheckDuration {
  repo: string;
  name: string;
  durationMs: number;
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

export function formatMergeEta(eta: MergeEta): string {
  return `PR #${eta.number}: merge ETA ${eta.rangeMinutes ? `${eta.rangeMinutes[0]}–${eta.rangeMinutes[1]} min` : 'unknown'}`
    + (eta.queuePosition === null ? '' : ` (queue #${eta.queuePosition})`);
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
  read: GhRead = args => ghRead(cwd, args)): MergeEta[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return [];
  const [owner, name] = repo.split('/');
  const deadline = Date.now() + 8_000;
  try {
    const response = read(['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(first:10,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number mergeQueueEntry{position}}}}}',
      '-f', `owner=${owner}`, '-f', `name=${name}`]) as { data?: { repository?: { pullRequests?: { nodes?: unknown[] } } } } | null;
    const nodes = response?.data?.repository?.pullRequests?.nodes;
    if (!Array.isArray(nodes)) return [];
    return nodes.slice(0, 10).flatMap(raw => {
      const pr = raw as { number?: number; mergeQueueEntry?: { position?: number } | null } | null;
      if (!pr || !Number.isSafeInteger(pr.number) || pr.number! < 1) return [];
      const position = pr.mergeQueueEntry?.position;
      const queuePosition = Number.isSafeInteger(position) && position! > 0 ? position! : null;
      const checks = queuePosition === null || history.length === 0 || Date.now() >= deadline ? null
        : read(['pr', 'checks', String(pr.number), '--repo', repo, '--required', '--json', 'name,bucket']);
      const names = Array.isArray(checks) && checks.every(c => c && typeof c.name === 'string' && ['pass', 'pending'].includes(c.bucket))
        ? checks.map(c => c.name as string) : [];
      return [estimateMergeEta(repo, pr.number!, queuePosition, names, history)];
    });
  } catch { return []; }
}
