/** Metadata-only spend feed for router rewards and PostHog. No network or credentials. */
import { createHash } from 'node:crypto';

export interface CodingSpendRecord {
  schemaVersion: 1;
  kind: 'spend';
  recordId: string;
  timestamp: string;
  repo: string;
  taskId: string;
  attemptId: string;
  pool: string;
  taskClass: string;
  engine: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  costBasis: 'reported' | 'estimated' | 'unknown';
}

export interface CodingMergeRecord {
  schemaVersion: 1;
  kind: 'merged';
  timestamp: string;
  repo: string;
  prNumber: number;
  taskIds: string[];
}

interface Totals {
  spendRecords: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  missingTokensIn: number;
  missingTokensOut: number;
  missingCost: number;
  estimatedCostRecords: number;
}

export interface CodingCostRollup extends Totals {
  repo: string;
  pool: string;
  taskClass: string;
  engine: string;
  model: string;
  tasks: number;
}

const label = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,199}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function time(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
  return new Date(v).toISOString() === (v.includes('.') ? v : v.replace('Z', '.000Z'));
}
const spendKeys = ['schemaVersion', 'kind', 'recordId', 'timestamp', 'repo', 'taskId', 'attemptId', 'pool', 'taskClass', 'engine', 'model', 'tokensIn', 'tokensOut', 'costUsd', 'costBasis'];
const mergeKeys = ['schemaVersion', 'kind', 'timestamp', 'repo', 'prNumber', 'taskIds'];

/** Reject extra fields rather than forwarding prompts, arbitrary properties or credentials. */
export function parseCodingCostRecord(value: unknown): CodingSpendRecord | CodingMergeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid coding cost record');
  const r = value as Record<string, unknown>;
  const keys = r['kind'] === 'spend' ? spendKeys : mergeKeys;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k)) || r['schemaVersion'] !== 1 || !time(r['timestamp']) || !label(r['repo'])) throw new Error('Invalid coding cost record');
  if (r['kind'] === 'spend') {
    if (!['recordId', 'taskId', 'attemptId', 'pool', 'taskClass', 'engine', 'model'].every(k => label(r[k])) ||
      !['tokensIn', 'tokensOut'].every(k => r[k] === null || count(r[k])) ||
      !(r['costUsd'] === null || (typeof r['costUsd'] === 'number' && Number.isFinite(r['costUsd']) && r['costUsd'] >= 0)) ||
      !['reported', 'estimated', 'unknown'].includes(String(r['costBasis'])) ||
      (r['costBasis'] === 'unknown') !== (r['costUsd'] === null)) throw new Error('Invalid coding spend record');
    return r as unknown as CodingSpendRecord;
  }
  if (r['kind'] !== 'merged' || !count(r['prNumber']) || r['prNumber'] === 0 || !Array.isArray(r['taskIds']) || !r['taskIds'].length || !r['taskIds'].every(label) || new Set(r['taskIds']).size !== r['taskIds'].length) throw new Error('Invalid coding merge record');
  return r as unknown as CodingMergeRecord;
}

const identity = (...parts: unknown[]): string => JSON.stringify(parts);
function eventUuid(value: string): string {
  // RFC 4122 UUIDv5 in the URL namespace, namespaced again for this feed.
  const bytes = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')).update(`phantom-router:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const dimensions = (r: CodingSpendRecord): string => identity(r.repo, r.pool, r.taskClass, r.engine, r.model);

function totals(rows: CodingSpendRecord[]): Totals {
  const result = {
    spendRecords: rows.length,
    tokensIn: rows.reduce((n, r) => n + (r.tokensIn ?? 0), 0),
    tokensOut: rows.reduce((n, r) => n + (r.tokensOut ?? 0), 0),
    costUsd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    missingTokensIn: rows.filter(r => r.tokensIn === null).length,
    missingTokensOut: rows.filter(r => r.tokensOut === null).length,
    missingCost: rows.filter(r => r.costUsd === null).length,
    estimatedCostRecords: rows.filter(r => r.costBasis === 'estimated').length,
  };
  if (!Number.isSafeInteger(result.tokensIn) || !Number.isSafeInteger(result.tokensOut) || !Number.isFinite(result.costUsd)) throw new Error('Coding cost totals overflow');
  return result;
}

function aggregate(records: CodingSpendRecord[]): CodingCostRollup[] {
  const groups = new Map<string, CodingSpendRecord[]>();
  for (const r of records) {
    const key = dimensions(r);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => {
    const first = rows[0]!;
    return {
      repo: first.repo, pool: first.pool, taskClass: first.taskClass, engine: first.engine, model: first.model,
      tasks: new Set(rows.map(r => r.taskId)).size, ...totals(rows),
    };
  });
}

/** Full-snapshot join: include every attempt, including failed attempts, in PR cost.
 * Repeated identical records are idempotent; conflicting identities fail closed.
 * A task may belong to only one PR in a repository. No merge inference from status.
 */
export function buildCodingCostFeed(input: readonly unknown[]) {
  const spends = new Map<string, CodingSpendRecord>();
  const merges = new Map<string, CodingMergeRecord>();
  for (const value of input) {
    const r = parseCodingCostRecord(value);
    const key = r.kind === 'spend' ? identity(r.repo, r.recordId) : identity(r.repo, r.prNumber);
    const map = r.kind === 'spend' ? spends : merges;
    const prior = map.get(key);
    // Compare canonical field order, independent of JSON object key order.
    const canonical = (row: CodingSpendRecord | CodingMergeRecord) => JSON.stringify((row.kind === 'spend' ? spendKeys : mergeKeys).map(k => (row as unknown as Record<string, unknown>)[k]));
    if (prior && canonical(prior) !== canonical(r)) throw new Error('Conflicting coding cost record identity');
    if (r.kind === 'spend') spends.set(key, r);
    else merges.set(key, r);
  }
  const records = [...spends.values()].sort((a, b) => identity(a.repo, a.recordId).localeCompare(identity(b.repo, b.recordId)));
  const claimed = new Set<string>();
  const byMergedPr = [...merges.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.prNumber - b.prNumber).map(merge => {
    for (const task of merge.taskIds) {
      const key = identity(merge.repo, task);
      if (claimed.has(key)) throw new Error('Task attributed to multiple merged PRs');
      claimed.add(key);
    }
    const rows = records.filter(r => r.repo === merge.repo && merge.taskIds.includes(r.taskId));
    return { repo: merge.repo, prNumber: merge.prNumber, timestamp: merge.timestamp,
      missingTasks: merge.taskIds.filter(task => !rows.some(r => r.taskId === task)).sort(),
      totals: totals(rows), groups: aggregate(rows) };
  });
  const posthogEvents = records.map(r => ({
    event: 'coding_spend_recorded', timestamp: r.timestamp, uuid: eventUuid(identity('spend', r.repo, r.recordId)),
    properties: { ...r, distinct_id: 'phantom-router', $process_person_profile: false },
  }));
  // PR attribution is a separate additive event, so late spend can be replayed
  // without summing multiple versions of a cumulative PR snapshot.
  const mergedEvents = byMergedPr.flatMap(pr => records
    .filter(r => r.repo === pr.repo && merges.get(identity(pr.repo, pr.prNumber))!.taskIds.includes(r.taskId))
    .map(r => ({ event: 'coding_merged_pr_spend', timestamp: pr.timestamp, uuid: eventUuid(identity('merged-spend', r.repo, pr.prNumber, r.recordId)),
      properties: { ...r, prNumber: pr.prNumber, distinct_id: 'phantom-router', $process_person_profile: false },
    })));
  return { schemaVersion: 1 as const, byTaskClass: aggregate(records), byMergedPr, posthogEvents: [...posthogEvents, ...mergedEvents] };
}
