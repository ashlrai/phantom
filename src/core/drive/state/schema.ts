/** Value-free local queue.v1 stub until the drive queue owns this contract. */
export interface QueueRecord {
  kind: 'queue.v1';
  id: string;
  nodeId: string;
  fencingToken: number;
  updatedAt: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}
export interface BudgetRecord {
  kind: 'budget.v1';
  /** One stable ID per reservation; revisions replace, never add to it. */
  id: string;
  nodeId: string;
  fencingToken: number;
  updatedAt: number;
  reservedUsd: number;
  spentUsd: number;
  status: 'reserved' | 'settled' | 'released';
}
export interface MetricsRecord {
  kind: 'metrics.v1';
  /** Stable per node and window; overlapping snapshots must not be summed. */
  id: string;
  nodeId: string;
  fencingToken: number;
  updatedAt: number;
  window: '1d' | '7d' | '30d';
  since: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  sessions: number;
  commits: number;
}
export type StateRecord = QueueRecord | BudgetRecord | MetricsRecord;
export interface StateSnapshot { schema: 'drive-state.v1'; records: StateRecord[] }
const common = ['kind', 'id', 'nodeId', 'fencingToken', 'updatedAt'];
const fields = {
  'queue.v1': [...common, 'status'],
  'budget.v1': [...common, 'reservedUsd', 'spentUsd', 'status'],
  'metrics.v1': [...common, 'window', 'since', 'tokensIn', 'tokensOut', 'estCostUsd', 'sessions', 'commits'],
};
function invalid(): never { throw new Error('Invalid value-free drive state'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  // Reject accessors and serialization hooks without executing them.
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) invalid();
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
}
/** Validate before JSON.stringify so unknown values never reach Git objects. */
export function validateSnapshot(input: unknown): StateSnapshot {
  const root = object(input);
  exact(root, ['schema', 'records']);
  if (root.schema !== 'drive-state.v1' || !Array.isArray(root.records) || root.records.length > 10_000) invalid();
  const records: StateRecord[] = [];
  const seen = new Set<string>();
  for (const inputRecord of root.records) {
    const r = object(inputRecord);
    if (typeof r.kind !== 'string' || !Object.hasOwn(fields, r.kind)) invalid();
    const keys = fields[r.kind as keyof typeof fields];
    exact(r, keys);
    for (const key of keys) {
      const v = r[key];
      if (key === 'kind') continue;
      if (key === 'id' || key === 'nodeId') {
        if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) invalid();
      } else if (key === 'status') {
        const allowed = r.kind === 'queue.v1' ? ['pending', 'running', 'succeeded', 'failed', 'cancelled'] : ['reserved', 'settled', 'released'];
        if (typeof v !== 'string' || !allowed.includes(v)) invalid();
      } else if (key === 'window') {
        if (!['1d', '7d', '30d'].includes(v as string)) invalid();
      } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 ||
        (!['reservedUsd', 'spentUsd', 'estCostUsd'].includes(key) && !Number.isSafeInteger(v))) invalid();
    }
    const identity = `${r.kind}:${r.id}`;
    if (seen.has(identity)) invalid();
    seen.add(identity);
    records.push(Object.fromEntries(keys.map(k => [k, r[k]])) as unknown as StateRecord);
  }
  records.sort((a, b) => compareText(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
  return { schema: 'drive-state.v1', records };
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function serializeState(input: unknown): string { return JSON.stringify(validateSnapshot(input)); }
export function parseState(input: string): StateSnapshot {
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) invalid();
  try { return validateSnapshot(JSON.parse(input)); } catch { return invalid(); }
}
/** Total order: lease epoch, timestamp, canonical payload. Commutative and idempotent. */
export function mergeState(left: unknown, right: unknown): StateSnapshot {
  const records = new Map<string, StateRecord>();
  for (const snapshot of [validateSnapshot(left), validateSnapshot(right)]) {
    for (const r of snapshot.records) {
      const key = `${r.kind}:${r.id}`;
      const old = records.get(key);
      if (!old || r.fencingToken > old.fencingToken ||
        (r.fencingToken === old.fencingToken && (r.updatedAt > old.updatedAt ||
          (r.updatedAt === old.updatedAt && compareText(JSON.stringify(r), JSON.stringify(old)) > 0)))) records.set(key, r);
    }
  }
  return validateSnapshot({ schema: 'drive-state.v1', records: [...records.values()] });
}
