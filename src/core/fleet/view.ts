/**
 * src/core/fleet/view.ts: the `fleet-view.v1` aggregate behind
 * `phm fleet view`, the fleet view TUI, and `GET /api/verse/fleet/view`.
 *
 * One live view for humans and agents, fed by the router queue snapshot
 * (~/.ashlr-runs/queue/jobs.jsonl + status.json via router-queue.ts), per-
 * account resource windows (resource.v1 once the usage source lands; the
 * manual fleet.json readings/windows until then), the shared kill switch
 * (the same sentinel fleet.v1 status reads), and host memory/swap.
 *
 * Everything degrades independently and `null` always means unknown. This
 * module never writes, never dispatches, never throws, and never copies
 * credential-shaped or path text into the view: every free-text field is a
 * bounded, validated identifier or a short control-stripped title.
 */

import { execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { readKillSwitch } from '../sandbox/policy.js';
import {
  readRouterQueue,
  type RouterQueueSnapshot,
} from './router-queue.js';
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';

export const FLEET_VIEW_SCHEMA = 'fleet-view.v1' as const;

// ---------------------------------------------------------------------------
// Types (the JSON contract; camelCase, null means unknown)
// ---------------------------------------------------------------------------

export interface FleetViewAgent {
  id: string;
  lane: string;
  account: string;
  tier: string;
  repo: string | null;
  title: string | null;
  startedAt: string | null;
  elapsedSeconds: number | null;
  tokens: number | null;
}

export interface FleetViewAccount {
  id: string;
  lanes: string[];
  sharedWith: string | null;
  source: 'resource.v1' | 'manual' | 'estimate' | 'unknown';
  usedPct: number | null;
  remainingPct: number | null;
  credits: number | null;
  resetAt: string | null;
  windowStart: string | null;
  burnPctPerHour: number | null;
  runwayHours: number | null;
  projectedPct: number | null;
  idealPct: number | null;
  readingAt: string | null;
  ageSeconds: number | null;
}

export interface FleetViewLane {
  lane: string;
  account: string;
  tier: string | null;
  queued: number;
  running: number;
  tokens: number;
  agents: string[];
}

export interface FleetViewSourceFile {
  state: 'ok' | 'partial' | 'missing' | 'invalid' | 'unsafe';
  detail: string;
  bytes: number | null;
  sha256: string | null;
  mtimeMs: number | null;
}

export interface FleetView {
  schema: typeof FLEET_VIEW_SCHEMA;
  generatedAt: string;
  readOnly: true;
  pause: { state: 'engaged' | 'clear' | 'unknown'; reason: string | null };
  host: {
    state: 'measured' | 'partial' | 'unavailable';
    memoryTotalBytes: number | null;
    memoryUsedBytes: number | null;
    memoryUsedPct: number | null;
    swapTotalBytes: number | null;
    swapUsedBytes: number | null;
  };
  queue: {
    state: 'ok' | 'partial' | 'missing' | 'invalid' | 'unsafe';
    depth: number;
    running: number;
    jobs: number;
    byLane: { lane: string; queued: number; running: number }[];
  };
  agents: FleetViewAgent[];
  accounts: FleetViewAccount[];
  throughput: {
    completedJobs: number;
    merged: number;
    mergeRate: number | null;
    reverted: number;
    knownTokens: number;
    tokenSamples: number;
    recentMerged: { pr: string; lane: string; mergedAt: string | null; reverted: boolean | null; impact: number | null }[];
  };
  impact: {
    total: number | null;
    samples: number;
    perLane: { lane: string; merged: number; impact: number | null; impactPerToken: number | null }[];
  };
  lanes: FleetViewLane[];
  sources: {
    jobs: FleetViewSourceFile;
    status: FleetViewSourceFile & { applied: number; hashMatched: boolean | null };
    resources: { kind: 'resource.v1' | 'manual' | 'none'; state: 'ok' | 'partial' | 'missing' | 'invalid' | 'unsafe'; detail: string };
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FleetViewHostSample {
  memoryTotalBytes: number | null;
  memoryFreeBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
}

export interface FleetViewOptions {
  nowMs?: number;
  /** Queue directory; defaults to $ASHLR_RUNS_DIR/queue or ~/.ashlr-runs/queue. */
  queueDir?: string;
  /** resource.v1 file; defaults to $ASHLR_RESOURCE_PATH or <runs>/resource.json. */
  resourcePath?: string;
  /** Manual fleet.json; defaults to $PHANTOM_FLEET_PATH or <runs>/fleet.json. */
  fleetPath?: string;
  /** Runs root override used for the default resource/fleet paths. */
  runsDir?: string;
  /** Injectable host sample for tests. */
  host?: FleetViewHostSample;
  /** Injectable kill-switch read for tests. */
  pause?: FleetView['pause'];
  /** Injectable queue read for tests and the cached web path. */
  queue?: RouterQueueSnapshot;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Account ids and lane mapping
// ---------------------------------------------------------------------------

/**
 * The canonical account set: always listed, in order, so the bars show the
 * whole fleet's coverage (including accounts with no reading yet). Lanes the
 * router uses map onto these; unmapped lanes become accounts of their own.
 */
export const FLEET_ACCOUNT_IDS = [
  'codex-cmp',
  'codex-personal',
  'claude-max',
  'devin',
  'grok-build',
  'grok-ultra-weekly',
  'cursor',
  'omlx',
] as const;
export type FleetAccountId = (typeof FLEET_ACCOUNT_IDS)[number];

const LANE_ACCOUNT_ALIASES: Record<string, string> = {
  'codex-primary': 'codex-cmp',
  'codex:codex-primary': 'codex-cmp',
  'codex-cmp': 'codex-cmp',
  'codex-secondary': 'codex-personal',
  'codex:codex-secondary': 'codex-personal',
  'codex-personal': 'codex-personal',
  claude: 'claude-max',
  'claude-max': 'claude-max',
  local: 'omlx',
  'local-omlx': 'omlx',
  omlx: 'omlx',
  devin: 'devin',
  'devin-acu': 'devin',
  grok: 'grok-ultra-weekly',
  grokbot: 'grok-ultra-weekly',
  'grok-ultra-weekly': 'grok-ultra-weekly',
  'grok-build': 'grok-build',
  'grok-build-tokens': 'grok-build',
  cursor: 'grok-ultra-weekly',
};

function accountForLane(lane: string): string {
  return LANE_ACCOUNT_ALIASES[lane] ?? lane;
}

// ---------------------------------------------------------------------------
// Host sample (memory + swap)
// ---------------------------------------------------------------------------

/** macOS `sysctl vm.swapusage`: "total = 2048.00M  used = 512.00M  free = 1536.00M". */
function parseDarwinSwap(text: string): { swapTotalBytes: number; swapFreeBytes: number } | null {
  const total = /total\s*=\s*([\d.]+)M/.exec(text);
  const free = /free\s*=\s*([\d.]+)M/.exec(text);
  if (!total || !free) return null;
  const totalBytes = Math.round(Number(total[1]) * 1024 * 1024);
  const freeBytes = Math.round(Number(free[1]) * 1024 * 1024);
  return Number.isFinite(totalBytes) && Number.isFinite(freeBytes) ? { swapTotalBytes: totalBytes, swapFreeBytes: freeBytes } : null;
}

/** Linux `/proc/meminfo`: SwapTotal/SwapFree in kB. */
function parseProcMeminfo(text: string): { swapTotalBytes: number; swapFreeBytes: number } | null {
  const total = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(text);
  const free = /^SwapFree:\s+(\d+)\s+kB$/m.exec(text);
  if (!total || !free) return null;
  return { swapTotalBytes: Number(total[1]) * 1024, swapFreeBytes: Number(free[1]) * 1024 };
}

function readSwap(): { swapTotalBytes: number; swapFreeBytes: number } | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] });
      return parseDarwinSwap(out);
    }
    if (process.platform === 'linux') {
      const fd = openSync('/proc/meminfo', 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        return parseProcMeminfo(buffer.subarray(0, bytes).toString('utf8'));
      } finally {
        closeSync(fd);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function sampleHost(): FleetViewHostSample {
  let memoryTotalBytes: number | null = null;
  let memoryFreeBytes: number | null = null;
  try {
    memoryTotalBytes = totalmem();
    memoryFreeBytes = freemem();
  } catch {
    /* leave null */
  }
  const swap = readSwap();
  return {
    memoryTotalBytes,
    memoryFreeBytes,
    swapTotalBytes: swap?.swapTotalBytes ?? null,
    swapFreeBytes: swap?.swapFreeBytes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Resource reads: resource.v1 first, then manual fleet.json readings/windows
// ---------------------------------------------------------------------------

interface ResourceWindow {
  account: string;
  start: number;
  reset: number;
  resetEveryDays: number | null;
  timezone: string | null;
}

interface ResourceReading {
  account: string;
  usedPct: number;
  at: number;
}

interface ManualFleetFile {
  readings: ResourceReading[];
  windows: ResourceWindow[];
  state: 'ok' | 'invalid';
  rowsDropped: number;
}

const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;

function readJsonFile(path: string): { ok: true; value: unknown; bytes: number; mtimeMs: number } | { ok: false; state: 'missing' | 'unsafe' | 'invalid' } {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESOURCE_BYTES) return { ok: false, state: 'unsafe' };
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) return { ok: false, state: 'unsafe' };
      offset += count;
    }
    const text = buffer.toString('utf8');
    if (text.includes('�')) return { ok: false, state: 'invalid' };
    const value: unknown = JSON.parse(text);
    return { ok: true, value, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return { ok: false, state: 'missing' };
    }
    if (error instanceof SyntaxError) return { ok: false, state: 'invalid' };
    return { ok: false, state: 'unsafe' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function instantMs(value: unknown): number | null {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? ms : null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function boundedText(value: unknown, max = 128): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[^\x20-\x7E]/.test(value) ? value : null;
}

/** Weekly wall-clock recurrence follows the configured timezone through DST. */
function shiftDays(ms: number, days: number, zone: string | null): number {
  if (!zone) return ms + days * 86_400_000;
  try {
    const parts = (t: number) => Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(t).map((p) => [p.type, p.value]),
    );
    const p = parts(ms);
    const target = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + days, Number(p.hour), Number(p.minute), Number(p.second));
    let candidate = target;
    for (let i = 0; i < 3; i++) {
      const q = parts(candidate);
      const local = Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour), Number(q.minute), Number(q.second));
      candidate += target - local;
    }
    return candidate;
  } catch {
    return NaN;
  }
}

function parseManualFleet(value: unknown, now: number): ManualFleetFile {
  const root = isObject(value) ? value : {};
  let rowsDropped = 0;
  const readings: ResourceReading[] = [];
  for (const item of Array.isArray(root['readings']) ? root['readings'].slice(-1000) : []) {
    if (!isObject(item)) { rowsDropped += 1; continue; }
    const account = typeof item['pool'] === 'string' ? item['pool'] : null;
    const usedPct = num(item['used_pct']);
    const at = instantMs(item['at']);
    if (account === null || account.length > 128 || usedPct === null || usedPct > 100 || at === null || at > now || item['source'] !== 'manual') {
      rowsDropped += 1;
      continue;
    }
    readings.push({ account, usedPct, at });
  }
  readings.sort((a, b) => a.at - b.at);

  const byAccount = new Map<string, ResourceWindow>();
  for (const item of Array.isArray(root['windows']) ? root['windows'].slice(0, 1000) : []) {
    if (!isObject(item)) { rowsDropped += 1; continue; }
    const account = typeof item['pool'] === 'string' ? item['pool'] : null;
    const reset = instantMs(item['reset']);
    const days = num(item['reset_every_days']);
    const timezone = typeof item['timezone'] === 'string' && /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(item['timezone']) ? item['timezone'] : null;
    if (account === null || account.length > 128 || reset === null) { rowsDropped += 1; continue; }
    let end = reset;
    let start = instantMs(item['start']) ?? (days !== null && days > 0 ? shiftDays(end, -days, timezone) : NaN);
    if (days !== null && days > 0 && days <= 366) {
      let steps = 0;
      while (end <= now && steps++ < 1000) {
        start = end;
        end = shiftDays(end, days, timezone);
      }
    }
    if (!Number.isFinite(start) || start >= end || end <= now || start > now) { rowsDropped += 1; continue; }
    byAccount.set(account, { account, start, reset: end, resetEveryDays: days, timezone });
  }
  return { readings, windows: [...byAccount.values()], state: isObject(value) ? 'ok' : 'invalid', rowsDropped };
}

/**
 * resource.v1 is the landing zone for RQ-CODEX-USAGE-SOURCE: a per-account
 * usage snapshot written by the collector. The fields here are read
 * defensively; an account row without a reading contributes only presence.
 */
interface ResourceV1Account {
  id: string;
  usedPct: number | null;
  remainingPct: number | null;
  credits: number | null;
  resetAt: number | null;
  windowStart: number | null;
  burnPctPerHour: number | null;
  runwayHours: number | null;
  projectedPct: number | null;
  idealPct: number | null;
  readingAt: number | null;
  estimate: boolean;
}

function parseResourceV1(value: unknown): { accounts: ResourceV1Account[]; state: 'ok' | 'invalid'; rowsDropped: number } {
  const root = isObject(value) ? value : {};
  if (root['schema'] !== 'resource.v1' && root['schemaVersion'] !== 1) {
    return { accounts: [], state: 'invalid', rowsDropped: 0 };
  }
  const list = Array.isArray(root['accounts']) ? root['accounts'] : Array.isArray(root['pools']) ? root['pools'] : [];
  const accounts: ResourceV1Account[] = [];
  let rowsDropped = 0;
  for (const item of list.slice(0, 1000)) {
    if (!isObject(item)) { rowsDropped += 1; continue; }
    const id = boundedText(item['id'] ?? item['account'] ?? item['pool']);
    if (id === null) { rowsDropped += 1; continue; }
    accounts.push({
      id,
      usedPct: num(item['usedPct'] ?? item['used_pct']),
      remainingPct: num(item['remainingPct'] ?? item['remaining_pct']),
      credits: num(item['credits']),
      resetAt: instantMs(item['resetAt'] ?? item['reset_at']),
      windowStart: instantMs(item['windowStart'] ?? item['window_start']),
      burnPctPerHour: num(item['burnPctPerHour'] ?? item['burn_pct_per_hour']),
      runwayHours: num(item['runwayHours'] ?? item['runway_hours']),
      projectedPct: num(item['projectedPct'] ?? item['projected_pct']),
      idealPct: num(item['idealPct'] ?? item['ideal_pct']),
      readingAt: instantMs(item['readingAt'] ?? item['reading_at']),
      estimate: item['estimate'] === true || item['source'] === 'estimate',
    });
  }
  return { accounts, state: 'ok', rowsDropped };
}

// ---------------------------------------------------------------------------
// Account assembly
// ---------------------------------------------------------------------------

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function emptyAccount(id: string, lanes: string[]): FleetViewAccount {
  return {
    id,
    lanes,
    sharedWith: id === 'cursor' ? 'grok-ultra-weekly' : null,
    source: 'unknown',
    usedPct: null, remainingPct: null, credits: null,
    resetAt: null, windowStart: null,
    burnPctPerHour: null, runwayHours: null, projectedPct: null, idealPct: null,
    readingAt: null, ageSeconds: null,
  };
}

function applyManualWindow(account: FleetViewAccount, file: ManualFleetFile, now: number): void {
  const window = file.windows.find((w) => w.account === (account.sharedWith ?? account.id));
  const readings = file.readings.filter((r) => r.account === account.id && (window === undefined || r.at >= window.start));
  const latest = readings.at(-1);
  const previous = readings.length >= 2 ? readings[readings.length - 2] : undefined;
  if (latest) {
    account.source = 'manual';
    account.usedPct = round1(latest.usedPct);
    account.remainingPct = round1(100 - latest.usedPct);
    account.readingAt = iso(latest.at);
    account.ageSeconds = Math.max(0, Math.floor((now - latest.at) / 1000));
  }
  if (window) {
    account.windowStart = iso(window.start);
    account.resetAt = iso(window.reset);
    account.idealPct = round1(Math.max(0, Math.min(100, (now - window.start) / (window.reset - window.start) * 100)));
  }
  // Two increasing observations in the same window give a measured burn; one
  // reading, a reversed counter, or no observations leave it unknown.
  if (latest && previous && latest.at > previous.at && latest.usedPct >= previous.usedPct) {
    const elapsedHours = (latest.at - previous.at) / 3_600_000;
    const burn = (latest.usedPct - previous.usedPct) / elapsedHours;
    account.burnPctPerHour = round1(burn);
    if (window) {
      account.projectedPct = round1(latest.usedPct + burn * (window.reset - latest.at) / 3_600_000);
    }
    if (burn > 0) {
      const hoursLeftAtReading = (100 - latest.usedPct) / burn;
      account.runwayHours = round1(Math.max(0, hoursLeftAtReading - (now - latest.at) / 3_600_000));
    }
  }
}

function applyResourceV1(account: FleetViewAccount, row: ResourceV1Account, now: number): void {
  account.source = row.estimate ? 'estimate' : 'resource.v1';
  account.usedPct = round1(row.usedPct);
  account.remainingPct = round1(row.remainingPct ?? (row.usedPct !== null ? 100 - row.usedPct : null));
  account.credits = row.credits;
  account.resetAt = iso(row.resetAt);
  account.windowStart = iso(row.windowStart);
  account.burnPctPerHour = round1(row.burnPctPerHour);
  account.runwayHours = round1(row.runwayHours);
  account.projectedPct = round1(row.projectedPct);
  account.idealPct = round1(row.idealPct);
  account.readingAt = iso(row.readingAt);
  account.ageSeconds = row.readingAt === null ? null : Math.max(0, Math.floor((now - row.readingAt) / 1000));
}

// ---------------------------------------------------------------------------
// Queue-derived sections
// ---------------------------------------------------------------------------

const COMPLETE_OUTCOMES = new Set(['merged', 'empty', 'failed', 'cancelled']);
const MAX_RECENT_MERGES = 8;
const MAX_AGENTS = 200;

function buildQueueSections(snapshot: RouterQueueSnapshot, now: number): Pick<FleetView, 'queue' | 'agents' | 'throughput' | 'impact' | 'lanes'> {
  const jobs = snapshot.jobs;
  const running = jobs.filter((j) => j.outcome === 'running');
  const queued = jobs.filter((j) => j.outcome === 'queued' || j.outcome === undefined);
  const completed = jobs.filter((j) => j.outcome !== undefined && COMPLETE_OUTCOMES.has(j.outcome));
  const merged = completed.filter((j) => j.outcome === 'merged');

  const agents: FleetViewAgent[] = running
    .slice()
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id))
    .slice(0, MAX_AGENTS)
    .map((job) => ({
      id: job.id,
      lane: job.lane,
      account: accountForLane(job.lane),
      tier: job.tier,
      repo: job.repo ?? null,
      title: job.title ?? null,
      startedAt: iso(job.startedAt ?? null),
      elapsedSeconds: job.startedAt === undefined ? null : Math.max(0, Math.floor((now - job.startedAt) / 1000)),
      tokens: job.tokens ?? null,
    }));

  const laneMap = new Map<string, FleetViewLane>();
  for (const job of jobs) {
    const lane = laneMap.get(job.lane) ?? { lane: job.lane, account: accountForLane(job.lane), tier: job.tier, queued: 0, running: 0, tokens: 0, agents: [] };
    if (job.outcome === 'running') {
      lane.running += 1;
      lane.agents.push(job.id);
      lane.tokens += job.tokens ?? 0;
    } else if (job.outcome === 'queued' || job.outcome === undefined) {
      lane.queued += 1;
    }
    laneMap.set(job.lane, lane);
  }
  const lanes = [...laneMap.values()].sort((a, b) => b.running - a.running || b.queued - a.queued || a.lane.localeCompare(b.lane));

  const byLane = lanes.map((lane) => ({ lane: lane.lane, queued: lane.queued, running: lane.running }));

  const tokenSamples = completed.filter((j) => j.tokens !== undefined).length;
  const knownTokens = completed.reduce((sum, j) => sum + (j.tokens ?? 0), 0);
  const recentMerged = merged
    .filter((j) => j.pr !== undefined)
    .slice()
    .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_RECENT_MERGES)
    .map((j) => ({
      pr: j.pr!,
      lane: j.lane,
      mergedAt: iso(j.mergedAt ?? null),
      reverted: j.reverted ?? null,
      impact: j.impact ?? null,
    }));

  const impactSamples = merged.filter((j) => j.reverted === true || (j.reverted === false && j.impact !== undefined)).length;
  const impactKnown = merged.length > 0 && impactSamples === merged.length;
  const totalImpact = impactKnown
    ? merged.reduce((sum, j) => sum + (j.reverted === true ? 0 : j.impact ?? 0), 0)
    : null;

  const perLane = [...new Set(merged.map((j) => j.lane))].sort().map((lane) => {
    const laneMerged = merged.filter((j) => j.lane === lane);
    const laneCompleted = completed.filter((j) => j.lane === lane);
    const laneImpactKnown = laneMerged.every((j) => j.reverted === true || (j.reverted === false && j.impact !== undefined));
    const laneTokensKnown = laneCompleted.length > 0 && laneCompleted.every((j) => j.tokens !== undefined);
    const laneImpact = laneImpactKnown ? laneMerged.reduce((sum, j) => sum + (j.reverted === true ? 0 : j.impact ?? 0), 0) : null;
    const laneTokens = laneTokensKnown ? laneCompleted.reduce((sum, j) => sum + (j.tokens ?? 0), 0) : null;
    return {
      lane,
      merged: laneMerged.length,
      impact: laneImpact,
      impactPerToken: laneImpact !== null && laneTokens !== null && laneTokens > 0 ? laneImpact / laneTokens : null,
    };
  }).sort((a, b) => (b.impact ?? -Infinity) - (a.impact ?? -Infinity) || a.lane.localeCompare(b.lane));

  return {
    queue: {
      state: snapshot.state,
      depth: queued.length,
      running: running.length,
      jobs: jobs.length,
      byLane,
    },
    agents,
    throughput: {
      completedJobs: completed.length,
      merged: merged.length,
      mergeRate: completed.length > 0 ? merged.length / completed.length : null,
      reverted: merged.filter((j) => j.reverted === true).length,
      knownTokens,
      tokenSamples,
      recentMerged,
    },
    impact: {
      total: totalImpact,
      samples: impactSamples,
      perLane,
    },
    lanes,
  };
}

// ---------------------------------------------------------------------------
// buildFleetView
// ---------------------------------------------------------------------------

function fleetViewDefaults(env: NodeJS.ProcessEnv): { queueDir: string; resourcePath: string; fleetPath: string } {
  const runsDir = typeof env['ASHLR_RUNS_DIR'] === 'string' && env['ASHLR_RUNS_DIR'].length > 0
    ? env['ASHLR_RUNS_DIR']
    : join(env['HOME'] ?? '', '.ashlr-runs');
  return {
    queueDir: join(runsDir, 'queue'),
    resourcePath: typeof env['ASHLR_RESOURCE_PATH'] === 'string' && env['ASHLR_RESOURCE_PATH'].length > 0
      ? env['ASHLR_RESOURCE_PATH']
      : join(runsDir, 'resource.json'),
    fleetPath: typeof env['PHANTOM_FLEET_PATH'] === 'string' && env['PHANTOM_FLEET_PATH'].length > 0
      ? env['PHANTOM_FLEET_PATH']
      : join(runsDir, 'fleet.json'),
  };
}

/**
 * Build the fleet-view.v1 snapshot. Pure file/host reads only; every source
 * degrades independently. Never throws.
 */
export function buildFleetView(options: FleetViewOptions = {}): FleetView {
  const env = options.env ?? process.env;
  const defaults = fleetViewDefaults(env);
  const now = options.nowMs ?? Date.now();

  const queue = options.queue ?? readRouterQueue(options.queueDir ?? defaults.queueDir);
  const sections = buildQueueSections(queue, now);

  // ── Resources: resource.v1 wins when present, manual fleet.json after. ──
  const lanesByAccount = new Map<string, string[]>();
  for (const lane of sections.lanes) {
    const list = lanesByAccount.get(lane.account) ?? [];
    list.push(lane.lane);
    lanesByAccount.set(lane.account, list);
  }
  const accountIds: string[] = [...FLEET_ACCOUNT_IDS];
  const seen = new Set<string>(accountIds);
  for (const account of [...lanesByAccount.keys()].sort()) {
    if (!seen.has(account)) {
      seen.add(account);
      accountIds.push(account);
    }
  }
  const accounts = new Map<string, FleetViewAccount>(
    accountIds.map((id) => [id, emptyAccount(id, (lanesByAccount.get(id) ?? []).sort())]),
  );

  const resources: FleetView['sources']['resources'] = { kind: 'none', state: 'missing', detail: 'no resource source found' };
  const resourceRead = readJsonFile(options.resourcePath ?? defaults.resourcePath);
  if (resourceRead.ok) {
    const parsed = parseResourceV1(resourceRead.value);
    if (parsed.state === 'ok' && parsed.accounts.length > 0) {
      resources.kind = 'resource.v1';
      resources.state = 'ok';
      resources.detail = 'resource.v1 snapshot applied';
      for (const row of parsed.accounts) {
        let account = accounts.get(row.id);
        if (!account) {
          account = emptyAccount(row.id, []);
          accounts.set(row.id, account);
        }
        applyResourceV1(account, row, now);
      }
      if (parsed.rowsDropped > 0) {
        resources.state = 'partial';
        resources.detail = 'resource.v1 applied with dropped rows';
      }
    }
  }
  if (resources.kind === 'none') {
    const fleetRead = readJsonFile(options.fleetPath ?? defaults.fleetPath);
    if (!fleetRead.ok) {
      resources.state = fleetRead.state;
      resources.detail = fleetRead.state === 'missing' ? 'no fleet.json readings'
        : fleetRead.state === 'unsafe' ? 'fleet.json not a safe regular file'
        : 'fleet.json is not clean UTF-8';
    } else {
      const manual = parseManualFleet(fleetRead.value, now);
      if (manual.state === 'invalid') {
        resources.state = 'invalid';
        resources.detail = 'fleet.json is not a JSON object';
      } else {
        resources.kind = 'manual';
        resources.state = 'ok';
        resources.detail = 'manual fleet.json readings applied';
        for (const account of accounts.values()) applyManualWindow(account, manual, now);
        // Manual readings may name accounts outside the canonical set.
        const extraIds = new Set([...manual.readings.map((r) => r.account), ...manual.windows.map((w) => w.account)]);
        for (const id of [...extraIds].sort()) {
          if (accounts.has(id)) continue;
          const account = emptyAccount(id, []);
          applyManualWindow(account, manual, now);
          accounts.set(id, account);
        }
        if (manual.rowsDropped > 0) {
          resources.state = 'partial';
          resources.detail = 'manual fleet.json applied with dropped rows';
        }
      }
    }
  }
  const orderedAccounts = [
    ...FLEET_ACCOUNT_IDS.map((id) => accounts.get(id)).filter((a): a is FleetViewAccount => a !== undefined),
    ...[...accounts.values()].filter((a) => !(FLEET_ACCOUNT_IDS as readonly string[]).includes(a.id)),
  ];

  // ── Pause (the same kill-switch sentinel fleet.v1 reads) ────────────────
  const pause = options.pause ?? (() => {
    const kill = readKillSwitch();
    return {
      state: kill.state === 'active' ? 'engaged' as const : kill.state === 'inactive' ? 'clear' as const : 'unknown' as const,
      reason: kill.reason,
    };
  })();

  // ── Host ────────────────────────────────────────────────────────────────
  const host = options.host ?? sampleHost();
  const memoryUsedBytes = host.memoryTotalBytes !== null && host.memoryFreeBytes !== null
    ? Math.max(0, host.memoryTotalBytes - host.memoryFreeBytes)
    : null;
  const swapUsedBytes = host.swapTotalBytes !== null && host.swapFreeBytes !== null
    ? Math.max(0, host.swapTotalBytes - host.swapFreeBytes)
    : null;
  const hostState = memoryUsedBytes !== null && swapUsedBytes !== null ? 'measured'
    : memoryUsedBytes !== null || swapUsedBytes !== null ? 'partial' : 'unavailable';

  return {
    schema: FLEET_VIEW_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    pause,
    host: {
      state: hostState,
      memoryTotalBytes: host.memoryTotalBytes,
      memoryUsedBytes,
      memoryUsedPct: memoryUsedBytes !== null && host.memoryTotalBytes ? round1(memoryUsedBytes / host.memoryTotalBytes * 100) : null,
      swapTotalBytes: host.swapTotalBytes,
      swapUsedBytes,
    },
    ...sections,
    accounts: orderedAccounts,
    sources: {
      jobs: {
        state: queue.jobsFile.state, detail: queue.jobsFile.detail,
        bytes: queue.jobsFile.bytes, sha256: queue.jobsFile.sha256, mtimeMs: queue.jobsFile.mtimeMs,
      },
      status: {
        state: queue.statusFile.state, detail: queue.statusFile.detail,
        bytes: queue.statusFile.bytes, sha256: queue.statusFile.sha256, mtimeMs: queue.statusFile.mtimeMs,
        applied: queue.statusFile.applied, hashMatched: queue.statusFile.hashMatched,
      },
      resources,
    },
  };
}
