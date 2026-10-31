/** Read-only projection of dispatchd's resource ledger and API spend tail. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { laneDeadSignals, type LaneDeadSignal } from './lane-dead-signal.js';
import { redactHomePaths, scrubPrivateText } from '../util/scrub.js';

export const VERSE_LEADER_RESOURCES_PATH = '/api/verse/leader/resources';
export interface ResourceLaneRow {
  lane: string; running: number | null; target: number | null; held: boolean | null;
  window: 'weekly' | 'credits' | 'none';
  usedPct: number | null; creditsRemaining: number | null; resetAt: string | null;
  burnPctPerHour: number | null; tokensPerHour6h: number | null; projectedExhaustion: string | null;
  source: string | null; deadSignal: LaneDeadSignal | null;
}
export interface ApiSpendSummary {
  rowsToday: number; errorsToday: number; tokensOutToday: number; tokensInToday: number;
  usdToday: number | null; usdWeek: number | null; lastAt: string | null; models: string[];
}
export interface ResourceLedgerV1 {
  v: 1; generatedAt: string; sources: Record<'status' | 'apiSpend' | 'jobs', 'healthy' | 'missing' | 'degraded'>;
  asOf: string | null; lanes: ResourceLaneRow[]; apiSpend: ApiSpendSummary | null; jobsMalformedRows: number | null;
}
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const timestamp = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const safeName = (v: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v) && scrubPrivateText(v) === v;
const missing = (e: unknown): boolean => object(e) && e.code === 'ENOENT';
const STATUS_MAX = 1024 * 1024;
const SPEND_TAIL = 512 * 1024;

async function readBounded(path: string, limit: number, tail: boolean): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (!tail && info.size > limit)) throw new Error('invalid source');
    const start = tail ? Math.max(0, info.size - limit) : 0;
    const bytes = Buffer.alloc(Math.min(info.size, limit));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const text = bytes.subarray(0, offset).toString('utf8');
    if (!start) return text;
    const newline = text.indexOf('\n');
    return newline < 0 ? '' : text.slice(newline + 1);
  } finally { await file.close(); }
}

/** Offset follows Date#getTimezoneOffset: minutes west of UTC. Week starts Monday. */
function parseSpend(lines: string, nowMs: number, tzOffsetMinutes: number): { summary: ApiSpendSummary; corrupt: boolean } {
  const summary: ApiSpendSummary = { rowsToday: 0, errorsToday: 0, tokensOutToday: 0, tokensInToday: 0, usdToday: null, usdWeek: null, lastAt: null, models: [] };
  const offset = tzOffsetMinutes * 60_000;
  const localNow = new Date(nowMs - offset);
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) + offset;
  const week = today - ((localNow.getUTCDay() + 6) % 7) * 86_400_000;
  const models = new Set<string>();
  let lastMs = -Infinity;
  let corrupt = false;
  for (const line of lines.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { corrupt = true; continue; }
    if (!object(row)) { corrupt = true; continue; }
    const at = timestamp(row.ts) ?? timestamp(row.at) ?? timestamp(row.timestamp);
    if (!at) { corrupt = true; continue; }
    const ms = Date.parse(at);
    if (ms > nowMs) continue;
    if (ms > lastMs) { lastMs = ms; summary.lastAt = at; }
    if (typeof row.model === 'string' && safeName(row.model)) models.add(row.model);
    const cost = number(row.cost_usd) ?? number(row.usd) ?? number(row.cost);
    if (ms >= week && cost !== null) summary.usdWeek = (summary.usdWeek ?? 0) + cost;
    if (ms < today) continue;
    summary.rowsToday++;
    if (row.is_error === true) summary.errorsToday++;
    summary.tokensInToday += number(row.input_tokens) ?? 0;
    summary.tokensOutToday += number(row.output_tokens) ?? 0;
    if (cost !== null) summary.usdToday = (summary.usdToday ?? 0) + cost;
  }
  summary.models = [...models].sort();
  return { summary, corrupt };
}
export function summarizeApiSpend(lines: string, nowMs: number, tzOffsetMinutes = new Date(nowMs).getTimezoneOffset()): ApiSpendSummary {
  return parseSpend(lines, nowMs, tzOffsetMinutes).summary;
}

export async function readResourceLedger(opts: { runsDir?: string; now?: () => number } = {}): Promise<ResourceLedgerV1> {
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const now = (opts.now ?? Date.now)();
  const result: ResourceLedgerV1 = { v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'missing', apiSpend: 'missing', jobs: 'missing' }, asOf: null, lanes: [], apiSpend: null, jobsMalformedRows: null };
  let signals: ReturnType<typeof laneDeadSignals> | null = null;
  await Promise.all([
    (async () => {
      try {
        const data: unknown = JSON.parse(await readBounded(join(root, 'queue/status.json'), STATUS_MAX, false));
        if (!object(data) || !object(data.lanes) || (data.budget != null && !object(data.budget))) throw new Error('invalid status');
        const budget = object(data.budget) ? data.budget : {};
        result.asOf = timestamp(data.last_tick);
        result.sources.status = result.asOf ? 'healthy' : 'degraded';
        for (const lane of new Set([...Object.keys(data.lanes), ...Object.keys(budget)])) {
          if (!safeName(lane)) { result.sources.status = 'degraded'; continue; }
          const l = object(data.lanes[lane]) ? data.lanes[lane] : {};
          const b = object(budget[lane]) ? budget[lane] : {};
          if ((lane in data.lanes && !object(data.lanes[lane])) || (lane in budget && !object(budget[lane]))) result.sources.status = 'degraded';
          const credits = number(b.credits_remaining);
          result.lanes.push({ lane, running: number(l.running), target: number(l.target), held: typeof l.held === 'boolean' ? l.held : null,
            window: lane === 'claude' || lane.startsWith('codex-') ? 'weekly' : credits !== null ? 'credits' : 'none',
            usedPct: number(b.weekly_used_pct), creditsRemaining: credits, resetAt: timestamp(b.reset_at),
            burnPctPerHour: number(b.burn_pct_per_hour), tokensPerHour6h: number(b.tokens_per_hour_6h), projectedExhaustion: timestamp(b.projected_exhaustion),
            source: typeof b.source === 'string' ? redactHomePaths(scrubPrivateText(b.source, { emails: true })).replace(/\p{Cc}/gu, ' ').slice(0, 160) : null, deadSignal: null });
        }
      } catch (e) { result.sources.status = missing(e) ? 'missing' : 'degraded'; }
    })(),
    (async () => {
      try {
        const text = await readBounded(join(root, 'metrics/jobs.jsonl'), SPEND_TAIL, true);
        const rows: unknown[] = text.split(/\r?\n/).filter(line => line.trim()).map(line => {
          try { return JSON.parse(line) as unknown; } catch { return null; }
        });
        signals = laneDeadSignals(rows);
        result.jobsMalformedRows = signals.malformedRows;
        result.sources.jobs = signals.malformedRows ? 'degraded' : 'healthy';
      } catch (e) { result.sources.jobs = missing(e) ? 'missing' : 'degraded'; }
    })(),
    (async () => {
      try {
        const parsed = parseSpend(await readBounded(join(root, 'metrics/api-spend.jsonl'), SPEND_TAIL, true), now, new Date(now).getTimezoneOffset());
        result.apiSpend = parsed.summary;
        result.sources.apiSpend = parsed.corrupt ? 'degraded' : 'healthy';
      } catch (e) { result.sources.apiSpend = missing(e) ? 'missing' : 'degraded'; }
    })(),
  ]);
  if (signals !== null) {
    const byLane = new Map((signals as ReturnType<typeof laneDeadSignals>).lanes.map(signal => [signal.lane, signal]));
    for (const lane of result.lanes) lane.deadSignal = byLane.get(lane.lane) ?? { lane: lane.lane, lastFinishes: 0, emptyFailures: 0, state: 'ok' };
  }
  return result;
}
