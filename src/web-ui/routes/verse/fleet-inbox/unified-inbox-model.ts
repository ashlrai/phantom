/** The unified comms inbox for the Inbox pane (GET /api/verse/comms/inbox). Read only; narrowing is defensive, never repairing. */
export const UNIFIED_INBOX_PATH = '/api/verse/comms/inbox?limit=20';
/** The CLI twin of this card. */
export const UNIFIED_INBOX_COMMAND = 'phm comms inbox';

const SOURCES = ['needs-you', 'imessage', 'drafts', 'bus'] as const;
const KINDS = ['needs-you', 'teammate-text', 'draft-approval', 'bus-work'] as const;
const SEVERITIES = ['info', 'warn', 'high'] as const;
const STATES = ['healthy', 'missing', 'degraded', 'unavailable'] as const;
const EXPIRES_SOON_MS = 30 * 60_000;

export type InboxSource = (typeof SOURCES)[number];
export type InboxKind = (typeof KINDS)[number];
export type InboxSeverity = (typeof SEVERITIES)[number];
export type InboxSourceState = (typeof STATES)[number];

export interface UnifiedInboxEntry {
  id: string;
  source: InboxSource;
  kind: InboxKind;
  severity: InboxSeverity;
  blocking: boolean;
  title: string;
  since: string | null;
  expiresAt: string | null;
  act: string[];
}

export interface UnifiedInboxSources {
  /** null: the source was absent from the response. */
  [source: string]: { state: InboxSourceState; pending: number } | null;
}

export type UnifiedInboxView =
  | { unavailable: true }
  | { unavailable?: false; total: number; omitted: number; sources: UnifiedInboxSources; items: UnifiedInboxEntry[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function readEntry(raw: unknown): UnifiedInboxEntry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  if (!oneOf(SOURCES, raw.source) || !oneOf(KINDS, raw.kind) || !oneOf(SEVERITIES, raw.severity)) return null;
  return {
    id: raw.id, source: raw.source, kind: raw.kind, severity: raw.severity,
    blocking: raw.blocking === true, title: raw.title,
    since: isoOrNull(raw.since), expiresAt: isoOrNull(raw.expiresAt),
    act: Array.isArray(raw.act) ? raw.act.filter((a): a is string => typeof a === 'string') : [],
  };
}

export function readUnifiedInboxView(data: unknown): UnifiedInboxView | null {
  if (!isRecord(data) || data.schema !== 'comms.unified-inbox.v1') return null;
  if (data.unavailable === true) return { unavailable: true };
  if (!isCount(data.total) || !isCount(data.omitted) || !isRecord(data.sources) || !Array.isArray(data.items)) return null;
  const sources: UnifiedInboxSources = {};
  for (const source of SOURCES) {
    const report = (data.sources as Record<string, unknown>)[source];
    sources[source] = isRecord(report) && oneOf(STATES, report.state) && isCount(report.pending)
      ? { state: report.state, pending: report.pending } : null;
  }
  const items = data.items.map(readEntry).filter((e): e is UnifiedInboxEntry => e !== null);
  return { total: data.total, omitted: data.omitted, sources, items };
}

const SOURCE_NAMES: Record<InboxSource, string> = { 'needs-you': 'Needs you', imessage: 'iMessage', drafts: 'Drafts', bus: 'Bus' };
const ITEM_LABELS: Record<InboxSource, string> = { 'needs-you': 'Needs you', imessage: 'Teammate text', drafts: 'Draft', bus: 'Bus work' };

/** "Needs you 3 · iMessage 1 · Drafts 0 · Bus degraded 2"; a missing source shows "—", never 0. */
export function sourceSummary(sources: UnifiedInboxSources): string {
  return SOURCES.map(source => {
    const report = sources[source] ?? null;
    if (report === null || report.state === 'missing') return `${SOURCE_NAMES[source]} —`;
    const state = report.state === 'healthy' ? '' : ` ${report.state}`;
    return `${SOURCE_NAMES[source]}${state} ${report.state === 'unavailable' ? '—' : report.pending}`;
  }).join(' · ');
}

function relativeAge(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function itemLine(item: UnifiedInboxEntry, nowMs: number): { label: string; title: string; age: string | null } {
  const parts: string[] = [];
  if (item.since !== null) parts.push(relativeAge(item.since, nowMs));
  if (item.expiresAt !== null) {
    const left = Date.parse(item.expiresAt) - nowMs;
    if (left <= EXPIRES_SOON_MS) parts.push(`expires in ${Math.max(0, Math.ceil(left / 60_000))}m`);
  }
  return { label: ITEM_LABELS[item.source], title: item.title, age: parts.length ? parts.join(' · ') : null };
}
