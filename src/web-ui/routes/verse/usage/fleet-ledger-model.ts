export interface ResourceLaneRow {
  lane: string;
  running: number | null;
  target: number | null;
  held: boolean | null;
  window: 'weekly' | 'credits' | 'none';
  usedPct: number | null;
  creditsRemaining: number | null;
  resetAt: string | null;
  burnPctPerHour: number | null;
  tokensPerHour6h: number | null;
  projectedExhaustion: string | null;
  source: string | null;
}
export interface ApiSpendSummary {
  rowsToday: number;
  errorsToday: number;
  tokensOutToday: number;
  tokensInToday: number;
  usdToday: number | null;
  usdWeek: number | null;
  lastAt: string | null;
  models: string[];
}
export interface ResourceLedgerV1 {
  v: 1;
  generatedAt: string;
  sources: Record<'status' | 'apiSpend', 'healthy' | 'missing' | 'degraded'>;
  asOf: string | null;
  lanes: ResourceLaneRow[];
  apiSpend: ApiSpendSummary | null;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nullableNumber = (v: unknown): boolean => v === null || number(v);
const nullableString = (v: unknown): boolean => v === null || typeof v === 'string';
const date = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown): boolean => v === null || date(v);
const sourceState = (v: unknown): boolean => v === 'healthy' || v === 'missing' || v === 'degraded';
const laneRow = (v: unknown): boolean => record(v) && typeof v.lane === 'string' &&
  nullableNumber(v.running) && nullableNumber(v.target) && (v.held === null || typeof v.held === 'boolean') &&
  (v.window === 'weekly' || v.window === 'credits' || v.window === 'none') && nullableNumber(v.usedPct) &&
  nullableNumber(v.creditsRemaining) && nullableDate(v.resetAt) && nullableNumber(v.burnPctPerHour) &&
  nullableNumber(v.tokensPerHour6h) && nullableDate(v.projectedExhaustion) && nullableString(v.source);
const spend = (v: unknown): boolean => record(v) && number(v.rowsToday) && number(v.errorsToday) &&
  number(v.tokensOutToday) && number(v.tokensInToday) && nullableNumber(v.usdToday) && nullableNumber(v.usdWeek) &&
  nullableDate(v.lastAt) && Array.isArray(v.models) && v.models.every((m: unknown) => typeof m === 'string');

/** Reject incompatible or malformed responses rather than displaying invented readings. */
export function isResourceLedger(v: unknown): v is ResourceLedgerV1 {
  return record(v) && v.v === 1 && date(v.generatedAt) && record(v.sources) && sourceState(v.sources.status) &&
    sourceState(v.sources.apiSpend) && nullableDate(v.asOf) && Array.isArray(v.lanes) && v.lanes.every(laneRow) &&
    (v.apiSpend === null || spend(v.apiSpend));
}

const grouped = (n: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n).replaceAll(',', ' ');
const compact = (n: number): string => n >= 1_000_000 ? `${grouped(n / 1_000_000)} M` : n >= 1_000 ? `${grouped(n / 1_000)} k` : grouped(n);
function duration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  if (days) return `${days} d${hours ? ` ${hours} h` : ''}`;
  if (hours) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${minutes} min`;
}
function future(iso: string | null, nowMs: number, prefix: string): string | null {
  if (iso === null) return null;
  const delta = Date.parse(iso) - nowMs;
  return Number.isFinite(delta) ? `${prefix} ${delta <= 0 ? 'now' : `in ${duration(delta)}`}` : null;
}
export function ledgerRows(data: ResourceLedgerV1, nowMs: number) {
  return data.lanes.map(row => ({
    lane: row.lane,
    usage: row.window === 'weekly' ? row.usedPct === null ? 'weekly usage unknown' : `${grouped(row.usedPct)} % of weekly`
      : row.window === 'credits' ? row.creditsRemaining === null ? 'credits unknown' : `${grouped(row.creditsRemaining)} credits left` : 'no cap tracked',
    resets: future(row.resetAt, nowMs, 'resets'),
    burn: row.burnPctPerHour !== null ? `${row.burnPctPerHour.toFixed(1)} %/h`
      : row.tokensPerHour6h !== null ? `${compact(row.tokensPerHour6h)} tok/h` : null,
    runsOut: future(row.projectedExhaustion, nowMs, 'runs out'),
    running: row.running !== null && row.target !== null ? `${grouped(row.running)}/${grouped(row.target)}` : null,
    held: row.held === true,
    source: row.source,
    tone: row.usedPct !== null && row.usedPct >= 90 ? 'bad' as const : row.usedPct !== null && row.usedPct >= 70 ? 'warn' as const : 'good' as const,
    caption: /claude/i.test(row.lane) ? 'Weekly window only. No 5-hour limit.' : null,
    usedPct: row.usedPct,
  }));
}
export function apiSpendLine(summary: ApiSpendSummary): string {
  return `Gift pool today: ${grouped(summary.rowsToday)} ${summary.rowsToday === 1 ? 'run' : 'runs'} · ${grouped(summary.errorsToday)} ${summary.errorsToday === 1 ? 'error' : 'errors'} · ${compact(summary.tokensOutToday)} tokens out${summary.usdToday === null ? '' : ` · $${summary.usdToday.toFixed(2)}`}`;
}
export function ageText(iso: string | null, nowMs: number): string {
  if (iso === null) return 'unknown';
  const delta = nowMs - Date.parse(iso);
  if (!Number.isFinite(delta)) return 'unknown';
  return delta < 60_000 ? 'just now' : `${duration(delta)} ago`;
}
export function asOfText(data: ResourceLedgerV1, nowMs: number): string {
  return `ledger as of ${ageText(data.asOf, nowMs)}`;
}
