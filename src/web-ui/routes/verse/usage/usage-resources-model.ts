/**
 * usage-resources-model.ts — the "Every resource" panel's rows (RQ-NIGHT-USAGE-1).
 *
 * Narrows the GET /api/verse/usage-resources body to the twelve fixed rows,
 * then projects each row into display text. Every state is rendered
 * honestly: a resource with no reader says "No reader yet", a reader that
 * ran but measured nothing says "No reading yet" — never a fake number.
 */
import {
  USAGE_RESOURCES,
  type UsageResourceRow,
  type UsageResourcesSnapshot,
  type UsageResourceUnit,
} from '../../../../core/usage/resource-usage-types.js';
import { formatMetricUsd } from '../../../components/charts/format-metric.js';
import { formatRelative } from '../autonomy/format.js';
import { formatReset } from '../fleet-usage/usage-pane-model.js';
import { usedPercentText } from '../percent-text.js';

export type UsageResourcesWire = UsageResourcesSnapshot;

export interface ResourceRowView {
  id: string;
  label: string;
  state: UsageResourceRow['state'];
  /** "62% used" / "$4.20 of $25.00" / "1,240 of 2,000 ACU"; null when no reading. */
  amountText: string | null;
  /** Meter fill 0–100, or null when the row cannot be metered. */
  percent: number | null;
  /** "in 3 d" / "overdue by 2 h" / "unknown". */
  resetText: string;
  /** "codex-session-logs", or the empty-state's own label ("No reader yet"). */
  sourceText: string;
  /** "as of 7m ago" when a real reading exists; null otherwise. */
  asOfText: string | null;
  /** Short state caption for non-ok rows; null on ok rows. */
  stateText: string | null;
}

const STATE_TEXT: Record<Exclude<UsageResourceRow['state'], 'ok'>, string> = {
  'no-reader': 'No reader yet',
  'no-reading': 'No reading yet',
  unavailable: 'Read failed',
};

const REASON_TEXT: Record<Exclude<UsageResourceRow['reason'], null>, string> = {
  'reader-timeout': 'reader timed out',
  'reader-error': 'reader error',
  'invalid-reading': 'reader returned an invalid reading',
};

function isUnit(value: unknown): value is UsageResourceUnit {
  return value === 'percent' || value === 'acu' || value === 'usd' || value === 'points';
}

function narrowRow(raw: unknown): UsageResourceRow | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const nulNum = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
  const nulStr = (v: unknown) => v === null || typeof v === 'string';
  if (typeof row['id'] !== 'string' || typeof row['label'] !== 'string') return null;
  if (row['state'] !== 'ok' && row['state'] !== 'no-reading' && row['state'] !== 'no-reader' && row['state'] !== 'unavailable') return null;
  if (!nulNum(row['used']) || !nulNum(row['limit'])) return null;
  if (row['unit'] !== null && !isUnit(row['unit'])) return null;
  if (!nulStr(row['resetsAt']) || !nulStr(row['source']) || !nulStr(row['asOf'])) return null;
  if (row['reason'] !== null && row['reason'] !== 'reader-timeout' && row['reason'] !== 'reader-error' && row['reason'] !== 'invalid-reading') return null;
  return row as unknown as UsageResourceRow;
}

/** Full-body narrowing: v + generatedAt + exactly the twelve resources, in order. */
export function narrowUsageResources(raw: unknown): UsageResourcesWire | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body['v'] !== 1 || typeof body['generatedAt'] !== 'string' || !Array.isArray(body['resources'])) return null;
  const rows = body['resources'].map(narrowRow);
  if (rows.some((row) => row === null)) return null;
  const narrowed = rows as UsageResourceRow[];
  if (narrowed.length !== USAGE_RESOURCES.length) return null;
  for (let i = 0; i < USAGE_RESOURCES.length; i += 1) {
    if (narrowed[i]!.id !== USAGE_RESOURCES[i]!.id) return null;
  }
  return { v: 1, generatedAt: body['generatedAt'], resources: narrowed };
}

function whole(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function amount(used: number | null, limit: number | null, unit: UsageResourceUnit): string | null {
  if (unit === 'percent') return used === null ? null : `${usedPercentText(used)} used`;
  const usedText = used === null ? '—' : unit === 'usd' ? formatMetricUsd(used) : whole(used);
  const limitText = limit === null ? '—' : unit === 'usd' ? formatMetricUsd(limit) : whole(limit);
  const suffix = unit === 'acu' ? ' ACU' : unit === 'points' ? ' points' : '';
  return `${usedText} of ${limitText}${suffix}`;
}

function meterPercent(used: number | null, limit: number | null, unit: UsageResourceUnit): number | null {
  if (unit === 'percent') return used === null ? null : Math.max(0, Math.min(100, used));
  if (used === null || limit === null || limit <= 0) return null;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

/** Project the wire rows into display rows, preserving roster order. */
export function resourceRows(wire: UsageResourcesWire | null, nowMs: number = Date.now()): ResourceRowView[] {
  return (wire?.resources ?? USAGE_RESOURCES.map(({ id, label }) => ({
    id, label, state: 'no-reading' as const, used: null, limit: null, unit: null,
    resetsAt: null, source: null, asOf: null, reason: null,
  }))).map((row) => {
    if (row.state !== 'ok') {
      return {
        id: row.id, label: row.label, state: row.state,
        amountText: null, percent: null,
        resetText: row.state === 'unavailable' ? 'unknown' : '—',
        sourceText: row.state === 'unavailable' && row.reason ? REASON_TEXT[row.reason] : (row.source ?? ''),
        asOfText: null,
        stateText: STATE_TEXT[row.state],
      };
    }
    const unit = row.unit ?? 'percent';
    return {
      id: row.id, label: row.label, state: row.state,
      amountText: amount(row.used, row.limit, unit),
      percent: meterPercent(row.used, row.limit, unit),
      resetText: formatReset(row.resetsAt, nowMs),
      sourceText: row.source ?? '—',
      asOfText: row.asOf === null ? null : `as of ${formatRelative(row.asOf, nowMs)}`,
      stateText: null,
    };
  });
}
