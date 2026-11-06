import { isDeepStrictEqual as equal } from 'node:util';

export interface SyncStamp { updated_at: string; origin: string }
export type SyncValue = null | boolean | number | string | SyncValue[] | { [key: string]: SyncValue };
export interface SyncField extends SyncStamp { value: SyncValue }
export interface SyncRecord extends SyncStamp {
  id: string;
  kind: 'company-context' | 'fleet-state';
  fields: Record<string, SyncField>;
  // Physical absence is never a delete. Tombstones are explicit and versioned.
  deletion?: SyncField & { value: boolean };
}
export interface SyncConflict {
  id: string; field: string; left: SyncField; right: SyncField;
  resolution: 'owner' | 'last-writer' | 'delete-protected';
}
export interface SyncPolicy { owners?: Record<string, string>; deleteProtection?: boolean }
export interface SyncSnapshot { record: SyncRecord; conflicts: SyncConflict[] }
export interface SyncAdapter {
  read(): Promise<SyncSnapshot | undefined>;
  write(next: SyncSnapshot, expected: SyncSnapshot | undefined): Promise<void>;
}
export function validateRecord(record: SyncRecord): void {
  const stamps = [record, ...Object.values(record.fields), ...(record.deletion ? [record.deletion] : [])];
  if (!record.id || !['company-context', 'fleet-state'].includes(record.kind) ||
      stamps.some(s => !s.origin || !Number.isFinite(Date.parse(s.updated_at))) ||
      (record.deletion && typeof record.deletion.value !== 'boolean')) {
    throw new Error('Invalid sync record metadata');
  }
}
function latest<T extends SyncStamp>(a: T, b: T): T {
  const delta = Date.parse(a.updated_at) - Date.parse(b.updated_at);
  // Stable ties converge independently of adapter order, including same-origin edits.
  return delta > 0 || (delta === 0 && JSON.stringify(a) >= JSON.stringify(b)) ? a : b;
}
/** Pure three-way merge. Persist conflicts alongside the record before acknowledging a write. */
export function reconcile(left: SyncRecord, right: SyncRecord, base?: SyncRecord, policy: SyncPolicy = {}) {
  for (const record of [left, right, ...(base ? [base] : [])]) {
    validateRecord(record);
    if (record.id !== left.id || record.kind !== left.kind) throw new Error('Sync identity mismatch');
  }
  const conflicts: SyncConflict[] = [];
  function choose(field: string, a?: SyncField, b?: SyncField, previous?: SyncField): SyncField | undefined {
    if (equal(a, b)) return a;
    if (!a) return b;
    if (!b) return a;
    const owner = policy.owners?.[field];
    let winner = equal(a, previous) ? b : equal(b, previous) ? a : latest(a, b);
    let resolution: SyncConflict['resolution'] = 'last-writer';
    if (owner && (a.origin === owner) !== (b.origin === owner)) {
      winner = a.origin === owner ? a : b;
      resolution = 'owner';
    }
    if (!equal(a, previous) && !equal(b, previous)) conflicts.push({ id: left.id, field, left: a, right: b, resolution });
    return winner;
  }
  const entries: [string, SyncField][] = [];
  for (const key of new Set([...Object.keys(left.fields), ...Object.keys(right.fields)])) {
    const value = choose(key, left.fields[key], right.fields[key], base?.fields[key]);
    if (value) entries.push([key, value]);
  }
  let deletion = choose('$deleted', left.deletion, right.deletion, base?.deletion) as SyncRecord['deletion'];
  if (deletion?.value && policy.deleteProtection !== false) {
    const protectedValue = { ...deletion, value: false };
    conflicts.push({ id: left.id, field: '$deleted', left: deletion, right: protectedValue, resolution: 'delete-protected' });
    deletion = protectedValue;
  }
  const { updated_at, origin } = latest(left, right);
  const record: SyncRecord = { id: left.id, kind: left.kind, updated_at, origin, fields: Object.fromEntries(entries), ...(deletion ? { deletion } : {}) };
  // Preserve original stamps. Sync writes are identical on readback and produce no echo.
  return { record, conflicts, writeLeft: !equal(record, left), writeRight: !equal(record, right) };
}
