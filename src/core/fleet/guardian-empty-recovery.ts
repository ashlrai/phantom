import { createHash } from 'node:crypto';
import { classifyEmpty, type EmptyJobResult } from './empty-jobs.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { ledgerPhase } from './empty-cause.js';
import { importMarkdown } from '../queue/markdown.js';
import { planFallbackChain } from '../router/fallback.js';
import { routeRequestSchema } from '../routing/decision-schema.js';
import type { RouteSources } from '../routing/decision-candidates.js';

const guardian = (id: string): boolean => /^(?:RQ-FIX-MAIN-|FIXUP-MAIN-)[\w.-]+$/.test(id);
export const guardianReceipt = (root: string, tier: string): string => createHash('sha256').update(`${root}:${tier}`).digest('hex');
export interface GuardianEmptyEscalation { job: string; root: string; tier: string; reason: string; exitCode: number | null }

/** Reuse strict failover gates; missing quota, capacity or policy never authorizes a new lane. */
function alternateLane(attrs: string, failedLane: string | undefined, sources?: RouteSources): string | undefined {
  const snapshot = routeRequestSchema.safeParse(sources?.request);
  const spec = importMarkdown(`- DONE RQ-RECOVERY (${attrs}): Repair main.`).jobs[0];
  if (!sources || !snapshot.success || !spec || !failedLane
    || [spec.pool, spec.preferred_lane, failedLane].some(lane => lane === 'codex-local' || lane === 'omlx')) return;
  const request = routeRequestSchema.safeParse({ task_class: 'bug-fix', repo: spec.repo, tier_hint: spec.tier,
    lane_candidates: snapshot.data.lane_candidates, quota_state: snapshot.data.quota_state, machine_state: snapshot.data.machine_state,
    needs: spec.needs, min_tier: spec.min_tier, data_class: spec.data_class ?? 'internal',
    max_cost_class: spec.max_cost_class === 'local' ? 'local' : 'included' });
  if (!request.success) return;
  return planFallbackChain(request.data, sources, failedLane, Date.now()).lanes[0]?.lane;
}

/** Original artifacts stay untouched; deterministic child IDs and receipts bound retries per tier. */
export function planGuardianEmptyRecovery(queue: string, ledger: string, receipts: Set<string>, sources?: RouteSources): { lines: string[]; escalations: GuardianEmptyEscalation[] } {
  const entries = queue.split(/\r?\n/).flatMap(line => {
    const m = /^- (READY|DONE|CLAIMED(?: [\w.@:/-]+)*?) ([\w.-]+) \(([^)]*)\): (.+)$/.exec(line);
    if (!m || !guardian(m[2]!)) return [];
    return [{ status: m[1]!, id: m[2]!, attrs: m[3]!, repo: /\brepo=([\w.-]+)/.exec(m[3]!)?.[1],
      pool: /\bpool=([\w.-]+)/.exec(m[3]!)?.[1], tier: /\btier=(frontier|work|mid|fast)\b/.exec(m[3]!)?.[1],
      root: / guardian-retry-root=([\w.-]+) guardian-retry-tier=\w+$/.exec(m[4]!)?.[1] ?? m[2]!, goal: m[4]! }];
  });
  const latest = new Map<string, Record<string, unknown>>();
  const active = new Map<string, string | undefined>();
  const launched = new Map<string, number>();
  const tiers = new Map<string, string>();
  const lanes = new Map<string, string>();
  const published = new Set<string>();
  try {
    const rows = ledger.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
    const stamp = (row: Record<string, unknown>): number => parseLedgerTs(row.ts ?? row.timestamp ?? row.at) ?? NaN;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { lines: [], escalations: [] };
      if (guardian(String(row.job ?? row.job_id ?? row.jobId ?? row.id)) && (!Number.isFinite(stamp(row)) || stamp(row) > Date.now())) return { lines: [], escalations: [] };
    }
    for (const row of rows.sort((a, b) => (stamp(a) || 0) - (stamp(b) || 0))) {
      const id = row.job ?? row.job_id ?? row.jobId ?? row.id;
      if (typeof id !== 'string' || !guardian(id)) continue;
      const event = row.event ?? row.type ?? row.kind;
      const state = ledgerPhase(row);
      if (state === 'MERGED' || state === 'CLOSED') { published.add(id); latest.delete(id); active.delete(id); }
      else if (event === 'claim' || event === 'launch') {
        published.delete(id);
        lanes.delete(id);
        if (typeof (row.lane ?? row.pool) === 'string') lanes.set(id, String(row.lane ?? row.pool));
        launched.set(id, stamp(row));
        active.set(id, typeof row.repo === 'string' ? row.repo.replace(/^ashlrai\//, '') : entries.find(e => e.id === id)?.repo);
        latest.delete(id);
        if (typeof row.tier === 'string') tiers.set(id, row.tier);
      } else if (event === 'finish' && !published.has(id) && stamp(row) > (launched.get(id) ?? -Infinity)) { latest.set(id, row); active.delete(id); }
      else if (['publish', 'published', 'outcome'].includes(String(event))) {
        if (row.url || row.pr || row.prUrl) { published.add(id); latest.delete(id); active.set(id, entries.find(e => e.id === id)?.repo); }
      }
    }
  } catch { return { lines: [], escalations: [] }; } // Torn evidence never authorizes a retry.
  const lines: string[] = [], escalations: GuardianEmptyEscalation[] = [];
  const reserved = new Set<string>();
  for (const entry of entries) {
    if (entry.status === 'READY' && entry.root === entry.id) continue; // The source itself is already queued.
    const row = latest.get(entry.id), tier = tiers.get(entry.id) ?? entry.tier;
    if (!row || row.empty !== true || !entry.repo || !entry.pool || !tier || !['fast', 'mid', 'work', 'frontier'].includes(tier)) continue;
    if (entries.filter(e => e.id === entry.id).length !== 1) continue;
    const exitCode = typeof row.exit_code === 'number' && Number.isInteger(row.exit_code) ? row.exit_code : null;
    const failure: Pick<EmptyJobResult, 'reason' | 'outcome'> = classifyEmpty(null, null, { exitCode, poolError: Boolean(row.pool_error) });
    if (failure.outcome !== 'failed') continue;
    const key = guardianReceipt(entry.root, tier);
    const child = `${entry.root}-EMPTYRETRY-${tier}`;
    if (entry.root !== entry.id || receipts.has(key) && !entries.some(e => e.id === child)) {
      escalations.push({ job: entry.id, root: entry.root, tier, reason: failure.reason, exitCode }); continue;
    }
    if (receipts.has(key)) continue;
    if (reserved.has(entry.repo) || [...active.values()].some(repo => !repo || repo === entry.repo)
      || entries.some(e => e.id !== entry.id && e.repo === entry.repo && e.status !== 'DONE' && !latest.has(e.id))) continue;
    if (entries.some(e => e.id === child || e.root === entry.root && e.id !== entry.id)) continue;
    const attrs = entry.attrs.replace(/\btier=(frontier|work|mid|fast)\b/, `tier=${tier}`);
    const lane = alternateLane(attrs, typeof (row.lane ?? row.pool) === 'string' ? String(row.lane ?? row.pool) : lanes.get(entry.id), sources);
    if (!lane) continue;
    const route = attrs.replace(/\b(pool|lane|preferred_lane)=[\w.-]+/g, `$1=${lane}`);
    lines.push(`- READY ${child} (${route}): ${entry.goal} Previous attempt ${entry.id} failed empty (exit ${exitCode ?? 'unknown'}). ${failure.reason} Inspect ${entry.id}.log and its original finish record before retrying. guardian-retry-root=${entry.root} guardian-retry-tier=${tier}`);
    reserved.add(entry.repo);
  }
  return { lines, escalations };
}
