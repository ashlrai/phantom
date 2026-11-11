/**
 * Live usage tick: official readouts first, browser fallback for lanes with no
 * readout, then budgets, alerts and a wake time that lands just after a reset.
 * Every provider surface is injected, so a tick is deterministic under test.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pullOfficialUsageSensors, type UsageSensorPullOptions } from '../sensor-pull.js';
import {
  USAGE_SENSOR_SCHEMA, USAGE_SENSOR_STALE_MS, parseUsageSensorSnapshot, presentUsageSensors,
  type UsageSensorLaneView, type UsageSensorReading,
} from '../sensor-reading.js';
import { readSite, type BrowserSession, type SiteReading } from './browser.js';
import { USAGE_SITES, type UsageSite } from './sites.js';

export const ALERT_LEVELS = ['cap-80', 'cap-95', 'expire-unspent'] as const;
export type AlertLevel = typeof ALERT_LEVELS[number] | 'needs-signin';
export const HISTORY_PER_LANE = 12;
/** Refresh this long after a reset, so the provider has rolled the window. */
export const RESET_REFRESH_DELAY_MS = 10_000;
export const EXPIRE_WINDOW_HOURS = 24;
export const EXPIRE_MIN_UNUSED_PCT = 25;

export interface ExtraReading { site: UsageSite['id']; budgetLane: string; used: number; limit: number; unit: 'percent' | 'acu'; resetAt: string | null; observedAt: string }
export interface UsageAlert { ts: string; level: AlertLevel; subject: string; message: string; pct: number | null; resetAt: string | null }
export interface AlertState { fired: Record<string, string> }
export interface NeedsSignin { site: UsageSite['id']; label: string; url: string }

interface Subject { id: string; pct: number; resetAt: string | null; hoursLeft: number | null; projectedUnusedPct: number | null }

const pctOf = (used: number, limit: number): number => limit > 0 ? Math.min(100, Math.round(used / limit * 1000) / 10) : 0;

function subjectsOf(lanes: readonly UsageSensorLaneView[], extras: readonly ExtraReading[], nowMs: number): Subject[] {
  const subjects: Subject[] = [];
  for (const v of lanes) {
    if (v.status !== 'fresh' || v.used === null || v.limit === null || !(v.limit > 0) || v.lane === 'local') continue;
    const hoursLeft = v.resetAt ? (Date.parse(v.resetAt) - nowMs) / 3_600_000 : null;
    let projectedUnusedPct: number | null = null;
    if (v.burnRate !== null && hoursLeft !== null && hoursLeft > 0) {
      projectedUnusedPct = Math.max(0, 100 - pctOf(v.used + v.burnRate * hoursLeft, v.limit));
    }
    subjects.push({ id: v.lane, pct: pctOf(v.used, v.limit), resetAt: v.resetAt, hoursLeft, projectedUnusedPct });
  }
  for (const e of extras) {
    const hoursLeft = e.resetAt ? (Date.parse(e.resetAt) - nowMs) / 3_600_000 : null;
    subjects.push({ id: e.budgetLane, pct: pctOf(e.used, e.limit), resetAt: e.resetAt, hoursLeft, projectedUnusedPct: null });
  }
  return subjects;
}

/** Each (subject, reset window, level) fires once. A jump past 95 marks 80 as fired too. */
export function evaluateAlerts(
  lanes: readonly UsageSensorLaneView[], extras: readonly ExtraReading[], state: AlertState, nowMs: number,
): { alerts: UsageAlert[]; state: AlertState } {
  const ts = new Date(nowMs).toISOString();
  const fired: Record<string, string> = {};
  for (const [key, at] of Object.entries(state.fired)) {
    if (nowMs - Date.parse(at) < 8 * 24 * 3_600_000) fired[key] = at;
  }
  const alerts: UsageAlert[] = [];
  const fire = (s: Subject, level: AlertLevel, message: string): void => {
    const key = `${s.id}|${s.resetAt ?? 'none'}|${level}`;
    if (fired[key]) return;
    fired[key] = ts;
    alerts.push({ ts, level, subject: s.id, message, pct: s.pct, resetAt: s.resetAt });
  };
  for (const s of subjectsOf(lanes, extras, nowMs)) {
    if (s.hoursLeft !== null && s.hoursLeft <= 0) continue;
    if (s.pct >= 95) {
      fire(s, 'cap-95', `${s.id} is at ${s.pct}% of its cap`);
      fired[`${s.id}|${s.resetAt ?? 'none'}|cap-80`] ??= ts;
    } else if (s.pct >= 80) fire(s, 'cap-80', `${s.id} is at ${s.pct}% of its cap`);
    if (s.hoursLeft !== null && s.hoursLeft <= EXPIRE_WINDOW_HOURS && s.projectedUnusedPct !== null &&
      s.projectedUnusedPct >= EXPIRE_MIN_UNUSED_PCT) {
      fire(s, 'expire-unspent',
        `${s.id} is projected to expire with ${Math.round(s.projectedUnusedPct)}% unspent in ${Math.round(s.hoursLeft * 10) / 10} h`);
    }
  }
  return { alerts, state: { fired } };
}

/**
 * A reset read as "in 2 hr 15 min" is re-derived each pass and drifts by minutes.
 * Keep the earlier instant when the new one is within tolerance, so the window
 * keeps one identity for alert dedupe and burn samples.
 */
export const RESET_SNAP_MS = 10 * 60_000;
export function snapReset(next: string | null, previous: readonly (string | null)[]): string | null {
  if (next === null) return null;
  const at = Date.parse(next);
  for (const p of previous) {
    if (p !== null && Math.abs(Date.parse(p) - at) <= RESET_SNAP_MS) return p;
  }
  return next;
}

/** Earliest future reset plus a delay, bounded by the poll interval. */
export function nextWakeMs(resets: readonly (string | null)[], nowMs: number, intervalMs: number): number {
  let wake = nowMs + intervalMs;
  for (const r of resets) {
    const at = r ? Date.parse(r) + RESET_REFRESH_DELAY_MS : NaN;
    if (Number.isFinite(at) && at > nowMs && at < wake) wake = at;
  }
  return wake;
}

/** budget block in the dispatchd status.json shape. `estimated` marks any derived or scraped value. */
export function budgetFragment(
  lanes: readonly UsageSensorLaneView[], sources: ReadonlyMap<string, string>, extras: readonly ExtraReading[], nowMs: number,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const hours = (r: string | null): number | null => r ? (Date.parse(r) - nowMs) / 3_600_000 : null;
  for (const v of lanes) {
    if (v.status !== 'fresh' || v.used === null || v.limit === null || !(v.limit > 0) || v.lane === 'local') continue;
    const name = v.lane === 'claude-max' ? 'claude' : v.lane;
    const source = sources.get(v.lane) ?? v.source ?? 'unknown';
    const burnPct = v.burnRate === null ? null : Math.round(v.burnRate / v.limit * 100 * 100) / 100;
    const left = hours(v.resetAt);
    const projected = burnPct !== null && burnPct > 0 && left !== null && left > 0
      ? new Date(nowMs + (100 - pctOf(v.used, v.limit)) / burnPct * 3_600_000).toISOString() : null;
    out[name] = { weekly_used_pct: pctOf(v.used, v.limit), reset_at: v.resetAt, source, burn_pct_per_hour: burnPct,
      projected_exhaustion: projected, observed_at: v.observedAt,
      estimated: source === 'browser-visible' || burnPct !== null };
  }
  for (const e of extras) {
    out[e.budgetLane] = { weekly_used_pct: pctOf(e.used, e.limit), reset_at: e.resetAt, source: 'browser-visible',
      burn_pct_per_hour: null, projected_exhaustion: null, observed_at: e.observedAt, estimated: true };
  }
  return out;
}

export interface LiveTickOptions {
  nowMs?: number;
  /** Holds usage-live.json, usage-live-state.json and usage-live-budget.json (the queue dir). */
  queueDir: string;
  busDir: string;
  intervalMs?: number;
  official?: UsageSensorPullOptions;
  /** Null skips the browser pass. */
  browser?: BrowserSession | null;
  sites?: readonly UsageSite[];
}
export interface LiveTickResult {
  generatedAt: string;
  readings: UsageSensorReading[];
  lanes: UsageSensorLaneView[];
  extras: ExtraReading[];
  siteReadings: SiteReading[];
  needsSignin: NeedsSignin[];
  alerts: UsageAlert[];
  budget: Record<string, Record<string, unknown>>;
  nextWakeAt: string;
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path);
}
function parseState(raw: unknown): AlertState {
  const fired = raw && typeof raw === 'object' ? (raw as { fired?: unknown }).fired : null;
  const out: Record<string, string> = {};
  if (fired && typeof fired === 'object') {
    for (const [k, v] of Object.entries(fired)) if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v;
  }
  return { fired: out };
}

export async function runLiveUsageTick(options: LiveTickOptions): Promise<LiveTickResult> {
  const nowMs = options.nowMs ?? Date.now();
  const interval = options.intervalMs ?? 5 * 60_000;
  await mkdir(options.queueDir, { recursive: true, mode: 0o700 });
  await mkdir(options.busDir, { recursive: true, mode: 0o700 });
  const snapshotPath = join(options.queueDir, 'usage-live.json');
  const prior = await readJson(snapshotPath);
  const history = parseUsageSensorSnapshot(prior);
  const priorExtras = (prior && typeof prior === 'object' && Array.isArray((prior as { extras?: unknown }).extras)
    ? (prior as { extras: ExtraReading[] }).extras : []);

  // 1. Official readouts.
  const pulled = await pullOfficialUsageSensors({ ...options.official, nowMs });
  const sources = new Map<string, string>();
  const fresh: UsageSensorReading[] = [];
  const unmeasured = new Set<string>();
  for (const r of pulled) {
    if (r.source === 'unmeasured') unmeasured.add(r.lane); else { fresh.push(r); sources.set(r.lane, r.source); }
  }

  // 2. Browser fallback only where no official readout exists.
  const siteReadings: SiteReading[] = [];
  const extras: ExtraReading[] = [];
  const needsSignin: NeedsSignin[] = [];
  if (options.browser) {
    for (const site of options.sites ?? USAGE_SITES) {
      if (site.lane !== null && !unmeasured.has(site.lane)) continue;
      const r = await readSite(site, options.browser, nowMs);
      siteReadings.push(r);
      if (r.status === 'needs-signin') { needsSignin.push({ site: r.site, label: r.label, url: r.url }); continue; }
      if (r.status !== 'ok') continue;
      if (site.lane === null) {
        const before = priorExtras.filter(e => e?.site === site.id).map(e => e.resetAt ?? null);
        extras.push({ site: site.id, budgetLane: site.budgetLane, used: r.used, limit: r.limit, unit: r.unit,
          resetAt: snapReset(r.resetAt, before), observedAt: r.observedAt });
      } else {
        const before = history.filter(h => h.lane === site.lane && h.source === 'browser-visible').map(h => h.resetAt);
        fresh.push({ lane: site.lane, observedAt: r.observedAt, source: 'browser-visible',
          staleAfter: new Date(nowMs + USAGE_SENSOR_STALE_MS).toISOString(), used: r.used, limit: r.limit,
          unit: r.unit, resetAt: snapReset(r.resetAt, before) });
        sources.set(site.lane, 'browser-visible');
      }
    }
  }

  // 3. History, so burn and the unspent projection have samples.
  const merged: UsageSensorReading[] = [...history, ...fresh];
  const byLane = new Map<string, UsageSensorReading[]>();
  for (const r of merged) byLane.set(r.lane, [...(byLane.get(r.lane) ?? []), r]);
  const kept = [...byLane.values()].flatMap(rows =>
    rows.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-HISTORY_PER_LANE));
  const report = presentUsageSensors(kept, nowMs);
  // A failed browser pass keeps the last extra until its own reset passes; stale ones are dropped by the alert gate.
  const liveExtras = extras.length ? extras : (options.browser ? [] : priorExtras.filter(e =>
    typeof e?.budgetLane === 'string' && typeof e.used === 'number' && typeof e.limit === 'number'
    && Date.parse(e.observedAt) + USAGE_SENSOR_STALE_MS > nowMs));

  // 4. Alerts, deduped across ticks.
  const state = parseState(await readJson(join(options.queueDir, 'usage-live-state.json')));
  const evaluated = evaluateAlerts(report.lanes, liveExtras, state, nowMs);
  const alerts = [...evaluated.alerts];
  const fired = { ...evaluated.state.fired };
  const day = new Date(nowMs).toISOString().slice(0, 10);
  for (const n of needsSignin) {
    const key = `${n.site}|${day}|needs-signin`;
    if (fired[key]) continue;
    fired[key] = new Date(nowMs).toISOString();
    alerts.push({ ts: new Date(nowMs).toISOString(), level: 'needs-signin', subject: n.site,
      message: `Sign in once at ${n.url} in the usage browser (${n.label})`, pct: null, resetAt: null });
  }

  // 5. Persist: snapshot, budget block, state, bus alerts.
  const budget = budgetFragment(report.lanes, sources, liveExtras, nowMs);
  const generatedAt = new Date(nowMs).toISOString();
  await writeAtomic(snapshotPath, `${JSON.stringify({ schema: USAGE_SENSOR_SCHEMA, generatedAt, readings: kept,
    extras: liveExtras, needsSignin }, null, 2)}\n`);
  await writeAtomic(join(options.queueDir, 'usage-live-budget.json'),
    `${JSON.stringify({ schema: 'usage-live-budget.v1', ts: Math.floor(nowMs / 1000), lanes: budget }, null, 2)}\n`);
  await writeAtomic(join(options.queueDir, 'usage-live-state.json'), `${JSON.stringify({ fired })}\n`);
  if (alerts.length) {
    await appendFile(join(options.busDir, 'usage-live-alerts.jsonl'),
      alerts.map(a => JSON.stringify(a)).join('\n') + '\n', { mode: 0o600 });
  }
  const nextWake = nextWakeMs([...report.lanes.map(l => l.resetAt), ...liveExtras.map(e => e.resetAt)], nowMs, interval);
  return { generatedAt, readings: kept, lanes: report.lanes, extras: liveExtras, siteReadings, needsSignin, alerts,
    budget, nextWakeAt: new Date(nextWake).toISOString() };
}

/** Plain markdown for ~/.ashlr-runs/bus/usage-live-first-readings.md. Numbers come only from this tick. */
export function renderFirstReadings(result: LiveTickResult): string {
  const rows = ['# Usage live: first readings', '', `Generated ${result.generatedAt}. Unknown means no verified reading.`, '',
    '| Pool | Used | Reset | Source |', '| --- | --- | --- | --- |'];
  for (const [name, b] of Object.entries(result.budget)) {
    rows.push(`| ${name} | ${b['weekly_used_pct']}% | ${b['reset_at'] ?? 'unknown'} | ${b['source']}${b['estimated'] ? ' (estimated)' : ''} |`);
  }
  if (!Object.keys(result.budget).length) rows.push('| none | unknown | unknown | no source readable |');
  rows.push('', '## Sites needing a one-time sign-in', '');
  if (!result.needsSignin.length) rows.push('None.');
  for (const n of result.needsSignin) rows.push(`- ${n.label}: ${n.url}`);
  const unreadable = result.siteReadings.filter(r => r.status === 'unreadable');
  if (unreadable.length) {
    rows.push('', '## Pages opened with no readable numbers', '');
    for (const r of unreadable) rows.push(`- ${r.site}: ${r.reason}`);
  }
  rows.push('', `Next refresh: ${result.nextWakeAt}`, '');
  return rows.join('\n');
}
