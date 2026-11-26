/** Projection of dispatchd's resource ledger and API spend tail. Read-only unless `recordHistory` is set. */
import { budgetTimestamp, quotaEvidence, type QuotaEvidence, type QuotaMeasurement } from './resource-reset-evidence.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { laneDeadSignals, type LaneDeadSignal } from './lane-dead-signal.js';
import { buildCodexResourceReport, collectCodexSessionUsages } from './codex-session-usage.js';
import { readClaudeQuotaReading, usableClaudeWeekly } from './claude-quota-reading.js';
import { redactHomePaths, scrubPrivateText } from '../util/scrub.js';

export const VERSE_LEADER_RESOURCES_PATH = '/api/verse/leader/resources';
export interface ResourceLaneRow {
  lane: string; running: number | null; target: number | null; held: boolean | null;
  window: 'weekly' | 'credits' | 'none';
  usedPct: number | null; creditsRemaining: number | null; resetAt: string | null;
  /** Set when `creditsRemaining` is a gift credit in US dollars (status `budget.<lane>.gift` or `.pools.gift`). */
  creditUnit?: 'usd';
  /** Gift credit only: when the balance was last read (null when never dated) and whether the lane's grant is closed. */
  creditAsOf?: string | null;
  creditClosed?: boolean;
  burnPctPerHour: number | null; tokensPerHour6h: number | null; projectedExhaustion: string | null;
  source: string | null; deadSignal: LaneDeadSignal | null;
  quotaEvidence?: QuotaEvidence;
  observation?: { source: 'codex-personal-sessions' | 'claude-native-usage'; asOf: string };
  /** Claude per-model weekly windows beside the all-models `usedPct`. */
  quotaScopes?: { id: string; usedPct: number; resetAt: string | null }[];
}
export interface ApiModelUsage {
  model: string; rows: number; errors: number; inputTokens: number; outputTokens: number;
  usd: number | null; lastAt: string;
}
export interface ApiSpendSummary {
  rowsToday: number; errorsToday: number; tokensOutToday: number; tokensInToday: number;
  usdToday: number | null; usdWeek: number | null; lastAt: string | null; models: string[];
  modelUsageToday: ApiModelUsage[]; modelUsageTodayOmitted: number;
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
const GIFT_MAX_AGE_MS = 24 * 3_600_000;
/**
 * The gift credit a lane's budget reports, in USD, merged from `gift` ({usd_remaining, as_of, expires_at}) and
 * `pools.gift` ({balance, expires_at, open}); the first block that has a field wins. The balance is kept while it is
 * fresh (under a day) or the credit has not yet expired, so an old reading still shows as "last reading <date>" and is
 * never 0. With no capture time, or once expired and old, it is unknown (null). `open: false` marks the lane closed;
 * it does not hide the balance. The expiry is kept whenever it is a real date.
 */
function giftCredit(budget: Obj, lastTick: unknown, now: number): { present: boolean; usd: number | null; expires: string | null; asOf: string | null; closed: boolean } {
  const pools = object(budget.pools) ? budget.pools : {};
  const blocks = [budget.gift, pools.gift].filter(object);
  if (!blocks.length) return { present: false, usd: null, expires: null, asOf: null, closed: false };
  const pick = <T,>(read: (g: Obj) => T | null): T | null => { for (const g of blocks) { const v = read(g); if (v !== null) return v; } return null; };
  const asOf = pick(g => timestamp(g.as_of));
  const seenAt = asOf ?? timestamp(lastTick);
  const seen = Date.parse(String(seenAt ?? ''));
  const dated = Number.isFinite(seen) && seen <= now + 60_000;
  const expires = pick(g => timestamp(g.expires_at));
  const live = expires !== null && Date.parse(expires) > now;
  const usd = pick(g => number(g.usd_remaining ?? g.balance));
  return { present: true, usd: dated && (now - seen <= GIFT_MAX_AGE_MS || live) ? usd : null, expires, asOf: seenAt,
    closed: blocks.some(g => g.open === false) };
}
const STATUS_MAX = 1024 * 1024;
const SPEND_TAIL = 512 * 1024;
const MODEL_USAGE_MAX = 100;

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
  const summary: ApiSpendSummary = { rowsToday: 0, errorsToday: 0, tokensOutToday: 0, tokensInToday: 0, usdToday: null, usdWeek: null, lastAt: null, models: [], modelUsageToday: [], modelUsageTodayOmitted: 0 };
  const offset = tzOffsetMinutes * 60_000;
  const localNow = new Date(nowMs - offset);
  const today = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) + offset;
  const week = today - ((localNow.getUTCDay() + 6) % 7) * 86_400_000;
  const models = new Set<string>();
  const usage = new Map<string, ApiModelUsage>();
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
    if (typeof row.model === 'string' && safeName(row.model)) {
      let model = usage.get(row.model);
      if (!model) {
        model = { model: row.model, rows: 0, errors: 0, inputTokens: 0, outputTokens: 0, usd: null, lastAt: at };
        usage.set(row.model, model);
      }
      model.rows++;
      if (row.is_error === true) model.errors++;
      model.inputTokens += number(row.input_tokens) ?? 0;
      model.outputTokens += number(row.output_tokens) ?? 0;
      if (cost !== null) model.usd = (model.usd ?? 0) + cost;
      if (ms > Date.parse(model.lastAt)) model.lastAt = at;
    }
  }
  summary.models = [...models].sort();
  const modelUsage = [...usage.values()].sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
  summary.modelUsageToday = modelUsage.slice(0, MODEL_USAGE_MAX);
  summary.modelUsageTodayOmitted = Math.max(0, modelUsage.length - MODEL_USAGE_MAX);
  return { summary, corrupt };
}
export function summarizeApiSpend(lines: string, nowMs: number, tzOffsetMinutes = new Date(nowMs).getTimezoneOffset()): ApiSpendSummary {
  return parseSpend(lines, nowMs, tzOffsetMinutes).summary;
}

/**
 * `recordHistory` appends this reading to metrics/usage-history.json (see
 * usage-history.ts). Off by default: most callers only read.
 */
export async function readResourceLedger(opts: { runsDir?: string; now?: () => number; personalCodexHome?: string; recordHistory?: boolean } = {}): Promise<ResourceLedgerV1> {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = (opts.now ?? Date.now)();
  const result: ResourceLedgerV1 = { v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'missing', apiSpend: 'missing', jobs: 'missing' }, asOf: null, lanes: [], apiSpend: null, jobsMalformedRows: null };
  // A controller tick republishes cached quotas; it never recaptures them.
  const statusQuotaObservedAt = new Map<string, string | null>();
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
          statusQuotaObservedAt.set(lane, b.estimated === true || b.stale === true ? null : budgetTimestamp(b.observed_at) ?? budgetTimestamp(b.as_of));
          if ((lane in data.lanes && !object(data.lanes[lane])) || (lane in budget && !object(budget[lane]))) result.sources.status = 'degraded';
          const gift = giftCredit(b, data.last_tick, now);
          const credits = number(b.credits_remaining) ?? gift.usd;
          result.lanes.push({ lane, running: number(l.running), target: number(l.target), held: typeof l.held === 'boolean' ? l.held : null,
            window: lane === 'claude' || lane.startsWith('codex-') ? 'weekly' : credits !== null || gift.present ? 'credits' : 'none',
            usedPct: number(b.weekly_used_pct), creditsRemaining: credits, resetAt: budgetTimestamp(b.reset_at) ?? gift.expires,
            ...(gift.present ? { creditUnit: 'usd' as const, creditAsOf: gift.asOf, creditClosed: gift.closed } : {}),
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
  const statusMeasurements = new Map(result.lanes.map(row => [row.lane, {
    lane: row.lane, window: row.window, usedPct: row.usedPct, resetAt: row.resetAt,
    source: row.source, observedAt: statusQuotaObservedAt.get(row.lane) ?? null,
  } satisfies QuotaMeasurement]));
  for (const row of result.lanes) row.quotaEvidence = quotaEvidence(statusMeasurements.get(row.lane)!, null, row.held, now);
  // Both collector slots point at the explicitly personal home. The collector
  // deduplicates them; relabel only that isolated reading before reporting it.
  const personalHome = opts.personalCodexHome ?? join(homedir(), '.codex-2');
  if (isAbsolute(personalHome) && personalHome === personalHome.trim() && personalHome.length <= 4096 &&
      !/\p{Cc}/u.test(personalHome) && resolve(personalHome) !== parse(personalHome).root &&
      !personalHome.split(/[\\/]+/).some(part => part === '.codex' || part === '..')) {
    const usages = collectCodexSessionUsages({ env: { CODEX_HOME: process.env.CODEX_HOME, CODEX_HOME_ALT: personalHome }, homeDir: homedir() });
    const report = buildCodexResourceReport(usages.map(usage => ({ ...usage, accountId: 'codex-personal', slot: 'secondary' as const })), [], now);
    const personal = report.resources[0];
    const observed = personal?.observedAt ? Date.parse(personal.observedAt) : NaN;
    let lane = result.lanes.find(row => row.lane === 'codex-personal');
    const statusQuota = statusMeasurements.get('codex-personal') ?? null;
    const quotaAt = statusQuota?.observedAt;
    const statusAt = quotaAt ? Date.parse(quotaAt) : NaN;
    const statusHasDatedReading = statusQuota?.usedPct != null && statusAt <= now;
    if (personal?.weekly?.usedPct != null &&
        (personal.weekly.windowMinutes === null || personal.weekly.windowMinutes > 315) &&
        Number.isFinite(observed) && observed <= now &&
        (!statusHasDatedReading || observed > statusAt)) {
      if (!lane) {
        lane = { lane: 'codex-personal', running: null, target: null, held: null,
          window: 'weekly', usedPct: null, creditsRemaining: null, resetAt: null,
          burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null,
          source: null, deadSignal: null };
        result.lanes.push(lane);
      }
      const measured: QuotaMeasurement = { lane: lane.lane, window: 'weekly',
        usedPct: personal.weekly.usedPct, resetAt: personal.weekly.resetsAt,
        source: 'codex-personal-sessions', observedAt: personal.observedAt };
      lane.quotaEvidence = quotaEvidence(statusQuota, measured, lane.held, now);
      lane.usedPct = personal.weekly.usedPct;
      lane.resetAt = personal.weekly.resetsAt;
      lane.burnPctPerHour = personal.weekly.burnPctPerHour;
      lane.tokensPerHour6h = null;
      lane.projectedExhaustion = personal.weekly.projectedExhaustionAt;
      lane.source = 'codex-personal-sessions';
      lane.observation = { source: 'codex-personal-sessions', asOf: personal.observedAt! };
    }
  }
  // Prefer native Claude usage over an unmeasured status value. A newer
  // timestamped status quota wins, independent of the controller tick.
  const claude = usableClaudeWeekly(await readClaudeQuotaReading(root), now);
  const claudeStatus = statusMeasurements.get('claude');
  const claudeStatusAt = Date.parse(claudeStatus?.observedAt ?? '');
  const newerClaudeStatus = claude && claudeStatus?.usedPct != null && claudeStatus.usedPct >= 0 &&
    claudeStatusAt <= now && claudeStatusAt > Date.parse(claude.observedAt);
  if (claude && !newerClaudeStatus) {
    let lane = result.lanes.find(row => row.lane === 'claude');
    if (!lane) {
      lane = { lane: 'claude', running: null, target: null, held: null,
        window: 'weekly', usedPct: null, creditsRemaining: null, resetAt: null,
        burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null,
        source: null, deadSignal: null };
      result.lanes.push(lane);
    }
    const measured: QuotaMeasurement = { lane: 'claude', window: 'weekly', usedPct: claude.weekly.usedPct,
      resetAt: claude.weekly.resetAt, source: 'claude-native-usage', observedAt: claude.observedAt };
    lane.quotaEvidence = quotaEvidence(claudeStatus ?? null, measured, lane.held, now);
    lane.usedPct = claude.weekly.usedPct;
    lane.resetAt = claude.weekly.resetAt;
    lane.source = 'claude-native-usage';
    lane.observation = { source: 'claude-native-usage', asOf: claude.observedAt };
    if (claude.scopes.length) lane.quotaScopes = claude.scopes;
  }
  if (signals !== null) {
    const byLane = new Map((signals as ReturnType<typeof laneDeadSignals>).lanes.map(signal => [signal.lane, signal]));
    for (const lane of result.lanes) lane.deadSignal = byLane.get(lane.lane) ?? { lane: lane.lane, lastFinishes: 0, emptyFailures: 0, state: 'ok' };
  }
  if (opts.recordHistory) await (await import('./usage-history.js')).recordLedgerUsage(root, result, now);
  return result;
}
