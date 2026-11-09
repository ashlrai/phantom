/**
 * Pure view of GET /api/verse/intent for the desktop Intent pane.
 * Unknown totals stay unknown. Stale rows are the ones the world model
 * also surfaces as blind spots.
 */
export interface IntentPanelRow {
  id: string;
  title: string;
  status: string;
  rq: string;
  partial: boolean;
  stale: boolean;
  pr: string;
}

export interface IntentPanelModel {
  ready: boolean;
  items: number | null;
  tracked: number | null;
  merged: number | null;
  shipped: number | null;
  verified: number | null;
  stale: number | null;
  rows: IntentPanelRow[];
}

interface IntentPayloadItem {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  rq?: unknown;
  partial?: unknown;
  prs?: unknown;
  lastTouchedAt?: unknown;
  staleAfterMs?: unknown;
}

export interface IntentPayload {
  present?: unknown;
  items?: unknown;
  tracked?: unknown;
  merged?: unknown;
  shipped?: unknown;
  verified?: unknown;
  stale?: unknown;
  staleItems?: unknown;
  records?: unknown;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function staleIds(payload: IntentPayload): Set<string> {
  if (!Array.isArray(payload.staleItems)) return new Set();
  return new Set(payload.staleItems.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const id = (row as { id?: unknown }).id;
    return typeof id === 'string' ? [id] : [];
  }));
}

export function intentPanelModel(payload: IntentPayload | null | undefined): IntentPanelModel {
  if (!payload || payload.present === false) {
    return { ready: false, items: null, tracked: null, merged: null, shipped: null, verified: null, stale: null, rows: [] };
  }
  const rows = Array.isArray(payload.records) ? payload.records as IntentPayloadItem[] : [];
  const stale = staleIds(payload);
  return {
    ready: true,
    items: count(payload.items),
    tracked: count(payload.tracked),
    merged: count(payload.merged),
    shipped: count(payload.shipped),
    verified: count(payload.verified),
    stale: count(payload.stale),
    rows: rows.flatMap((item) => {
      if (typeof item.id !== 'string' || typeof item.title !== 'string') return [];
      const rq = Array.isArray(item.rq) ? item.rq.filter((key): key is string => typeof key === 'string').join(' ') : '';
      const prs = Array.isArray(item.prs) ? item.prs : [];
      const first = prs.find((pull) => pull && typeof pull === 'object' && typeof (pull as { repo?: unknown }).repo === 'string');
      const pr = first && typeof first === 'object'
        ? `${(first as { repo: string }).repo}#${String((first as { number?: unknown }).number ?? '')}`
        : '';
      return [{
        id: item.id,
        title: item.title,
        status: typeof item.status === 'string' ? item.status : 'unknown',
        rq,
        partial: item.partial === true,
        stale: stale.has(item.id),
        pr,
      }];
    }),
  };
}
