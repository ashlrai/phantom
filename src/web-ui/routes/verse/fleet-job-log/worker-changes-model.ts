/** Local wire contract, independent of the server build. */
export interface FleetJobChangesV1 {
  schema: 'fleet.job.changes.v1';
  generatedAt: string;
  job: string;
  state: 'live' | 'missing' | 'degraded';
  baseSha: string | null;
  files: Array<{ path: string; added: number | null; removed: number | null; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' }>;
  totals: { files: number; added: number; removed: number };
  truncated: boolean;
  /** Changed paths the fleet admission rule refuses; absent on older builds. */
  refusals?: { path: string; rule: string }[];
}
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function isJobChanges(value: unknown): value is FleetJobChangesV1 {
  if (!obj(value) || !obj(value.totals)) return false;
  const totals = value.totals;
  return value.schema === 'fleet.job.changes.v1' && typeof value.generatedAt === 'string' && typeof value.job === 'string'
    && ['live', 'missing', 'degraded'].includes(String(value.state)) && (value.baseSha === null || typeof value.baseSha === 'string')
    && typeof value.truncated === 'boolean' && obj(value.totals) && ['files', 'added', 'removed'].every(key => count(totals[key]))
    && Array.isArray(value.files) && value.files.every(file => obj(file) && typeof file.path === 'string' && !file.path.startsWith('/') && !file.path.includes('\0')
      && (file.added === null || count(file.added)) && (file.removed === null || count(file.removed)) && ['modified', 'added', 'deleted', 'renamed', 'untracked'].includes(String(file.status)))
    && (value.refusals === undefined || (Array.isArray(value.refusals)
      && value.refusals.every(refusal => obj(refusal) && typeof refusal.path === 'string' && typeof refusal.rule === 'string')));
}
export function changesHeadline(changes: FleetJobChangesV1): string {
  return `Changes · ${changes.totals.files} ${changes.totals.files === 1 ? 'file' : 'files'} · +${changes.totals.added} −${changes.totals.removed}${changes.baseSha ? ` · vs base ${changes.baseSha.slice(0, 7)}` : ' · vs HEAD'}`;
}
export function collisionTell(changes: FleetJobChangesV1): string | null {
  const refusals = changes.refusals ?? [];
  if (refusals.length === 0) return null;
  return `Will collide: ${refusals.map(({ path, rule }) => `${path} (${rule.replace(/-/g, ' ')})`).join(', ')}`;
}
export function sortFiles(files: FleetJobChangesV1['files']): FleetJobChangesV1['files'] {
  const churn = (file: typeof files[number]) => (file.added ?? 0) + (file.removed ?? 0);
  return [...files].sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path));
}
