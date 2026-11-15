/** Local wire contract for fleet.job.activity.v1, independent of the server build. */

export type JobActivitySourceState = 'healthy' | 'missing' | 'degraded';

export interface JobActivityEventEntry {
  kind: 'event';
  at: string | null;
  event: string;
  summary: string;
}
export interface JobActivityCommandEntry {
  kind: 'command';
  text: string;
  line: number;
}
export interface JobActivityFilesEntry {
  kind: 'files';
  state: 'live' | 'missing' | 'degraded';
  baseSha: string | null;
  comparisonBase?: 'HEAD';
  files: Array<{ path: string; added: number | null; removed: number | null; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' }>;
  totals: { files: number; added: number; removed: number };
  truncated: boolean;
  refusals?: { path: string; rule: string }[];
}
export interface JobActivityReportEntry {
  kind: 'report';
  name: 'notes' | 'brief';
  state: 'ok' | 'missing' | 'unreadable';
  source: 'notes' | 'body' | null;
  bytes: number | null;
  truncated: boolean;
  text: string;
}
export type JobActivityEntry = JobActivityEventEntry | JobActivityCommandEntry | JobActivityFilesEntry | JobActivityReportEntry;

export interface JobActivityV1 {
  schema: 'fleet.job.activity.v1';
  generatedAt?: string | null;
  job?: string | null;
  state?: 'running' | 'published' | 'archived' | 'unknown' | null;
  lane?: string | null;
  tier?: string | null;
  model?: string | null;
  sources?: Partial<Record<'events' | 'commands' | 'files' | 'reports', JobActivitySourceState | null>> | null;
  counts?: { events?: number | null; commands?: number | null; files?: number | null; reports?: number | null } | null;
  truncated?: boolean | null;
  entries?: JobActivityEntry[] | null;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nullableStr = (v: unknown) => v == null || str(v);
const sourceState = (v: unknown) => v == null || v === 'healthy' || v === 'missing' || v === 'degraded';

function isEventEntry(v: unknown): v is JobActivityEventEntry {
  return obj(v) && v.kind === 'event' && str(v.event) && str(v.summary) && nullableStr(v.at);
}
function isCommandEntry(v: unknown): v is JobActivityCommandEntry {
  return obj(v) && v.kind === 'command' && str(v.text) && num(v.line);
}
function isFilesEntry(v: unknown): v is JobActivityFilesEntry {
  if (!obj(v) || v.kind !== 'files' || !obj(v.totals) || !Array.isArray(v.files)) return false;
  const totals = v.totals as Record<string, unknown>;
  return ['live', 'missing', 'degraded'].includes(String(v.state))
    && nullableStr(v.baseSha) && typeof v.truncated === 'boolean'
    && ['files', 'added', 'removed'].every(k => num(totals[k]))
    && v.files.every(f => obj(f) && str(f.path) && !f.path.startsWith('/') && !f.path.includes('\0')
      && (f.added === null || num(f.added)) && (f.removed === null || num(f.removed)) && str(f.status))
    && (v.refusals === undefined || (Array.isArray(v.refusals)
      && v.refusals.every(r => obj(r) && str(r.path) && str(r.rule))));
}
function isReportEntry(v: unknown): v is JobActivityReportEntry {
  return obj(v) && v.kind === 'report' && (v.name === 'notes' || v.name === 'brief')
    && ['ok', 'missing', 'unreadable'].includes(String(v.state))
    && (v.source === null || v.source === 'notes' || v.source === 'body')
    && (v.bytes === null || num(v.bytes)) && typeof v.truncated === 'boolean' && str(v.text);
}

export function isJobActivity(value: unknown): value is JobActivityV1 {
  if (!obj(value) || value.schema !== 'fleet.job.activity.v1') return false;
  if (value.entries !== undefined && value.entries !== null
    && (!Array.isArray(value.entries) || !value.entries.every(e =>
      isEventEntry(e) || isCommandEntry(e) || isFilesEntry(e) || isReportEntry(e)))) return false;
  if (value.sources !== undefined && value.sources !== null && obj(value.sources)
    && !Object.values(value.sources).every(sourceState)) return false;
  if (value.counts !== undefined && value.counts !== null && (!obj(value.counts)
    || !Object.values(value.counts).every(v => v == null || num(v)))) return false;
  return true;
}

/** Plain-text form of one entry, used by the stream's filter box. */
export function entrySearchText(entry: JobActivityEntry): string {
  switch (entry.kind) {
    case 'event': return `${entry.event} ${entry.summary} ${entry.at ?? ''}`;
    case 'command': return entry.text;
    case 'files': return `${entry.state} ${entry.totals.files} files ${entry.files.map(f => f.path).join(' ')} ${entry.baseSha ?? ''}`;
    case 'report': return `${entry.name} ${entry.source ?? ''} ${entry.text}`;
  }
}

export function filterActivityEntries(entries: readonly JobActivityEntry[], query: string): JobActivityEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter(entry => entrySearchText(entry).toLowerCase().includes(needle));
}

export function activityCountsLine(activity: JobActivityV1): string {
  const c = activity.counts ?? {};
  const parts = [
    `${c.events ?? 0} ${c.events === 1 ? 'event' : 'events'}`,
    `${c.commands ?? 0} ${c.commands === 1 ? 'command' : 'commands'}`,
    `${c.files ?? 0} ${c.files === 1 ? 'file' : 'files'}`,
    `${c.reports ?? 0} ${c.reports === 1 ? 'report' : 'reports'}`,
  ];
  return parts.join(' · ');
}

/** Short kind label shown beside each stream row. */
export function entryKindLabel(entry: JobActivityEntry): string {
  switch (entry.kind) {
    case 'event': return 'event';
    case 'command': return 'command';
    case 'files': return 'files';
    case 'report': return entry.name === 'notes' ? 'notes' : 'brief';
  }
}

/** `HH:MM:SS` for an ISO-ish ledger timestamp; the raw stamp (clipped) when it does not parse. */
export function eventTimeLabel(at: string | null): string {
  if (at === null) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(at);
  if (iso) return iso[2]!;
  const ms = Date.parse(at);
  if (Number.isFinite(ms)) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
  return at.slice(0, 24);
}
