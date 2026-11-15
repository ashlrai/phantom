/**
 * Read the local ledgers and Engineering Ops growth exports.
 * Missing files stay null. This module does not call gh.
 *
 * metrics JSON and JSONL use an 8 MiB cap. observe's readJsonFile stays at
 * 256 KiB; these files are larger than that and are not read through it.
 */
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readScorecardTrend } from '../fleet/scorecard.js';
import { scorecardHistoryDir } from '../fleet/scorecard-history.js';
import { parsePullExport, type PullFact } from '../observe/pulls.js';
import {
  projectGrowthSeries,
  type GrowthCostPoint,
  type GrowthExportClock,
  type GrowthFacts,
  type GrowthHourCount,
  type GrowthPull,
  type GrowthRange,
  type GrowthReport,
  type GrowthScorecard,
} from './series.js';

const JOBS_MAX_BYTES = 32 * 1024 * 1024;
const USAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 1W and 1M pull exports are larger than observe's 256 KiB cap. */
export const GROWTH_METRICS_MAX_BYTES = 8 * 1024 * 1024;

const PULLS_DAY = 'growth-pulls-1d.json';
const PULLS_HOURLY = 'growth-pulls-hourly.jsonl';
const RELEASES = 'growth-releases.jsonl';
const COST = 'growth-cost-hourly.jsonl';
const STATUS = 'growth-exports-status.json';

export interface GrowthReadOptions {
  nowMs?: number;
  metricsDir?: string;
  pulls?: readonly PullFact[] | null;
  pullsComplete?: boolean;
  pullsSource?: string;
  jobsText?: string | null;
  usageText?: string | null;
  hourlyPulls?: readonly GrowthPull[] | null;
  hourlyPullsComplete?: boolean;
  hourlyPullCounts?: readonly GrowthHourCount[] | null;
  releases?: readonly { at: number }[] | null;
  costHourly?: readonly GrowthCostPoint[] | null;
  exportClock?: GrowthExportClock | null;
  scorecard7d?: GrowthScorecard | null;
  scorecard30d?: GrowthScorecard | null;
}

function metricsRoot(options: GrowthReadOptions): string {
  return options.metricsDir ?? join(homedir(), '.ashlr-runs', 'metrics');
}

async function readBounded(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) return null;
    if (info.size === 0) return '';
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function fileMtime(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    return new Date(info.mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/** Line at a time, so a 1 MiB JSONL is not parsed as one JSON value. Over the cap is unread. */
export async function readGrowthJsonl(path: string, maxBytes = GROWTH_METRICS_MAX_BYTES): Promise<string[] | null> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) return null;
  if (info.size === 0) return [];
  const lines: string[] = [];
  let bytes = 0;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rows = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rows) {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > maxBytes) {
        stream.destroy();
        return null;
      }
      if (line.trim()) lines.push(line);
    }
  } catch {
    return null;
  }
  return lines;
}

async function readMetricsJson(path: string): Promise<unknown | null> {
  const text = await readBounded(path, GROWTH_METRICS_MAX_BYTES);
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stampOf(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const at = iso(row[key]);
    if (at) return Date.parse(at);
  }
  return null;
}

function parseStatus(raw: unknown): GrowthExportClock {
  const body = record(raw);
  const empty = { pulls: null, releases: null, cost: null };
  if (!body) return empty;
  const top = iso(body['generatedAt']);
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = body[key];
      if (typeof value === 'string') return iso(value) ?? top;
      const nested = record(value);
      if (nested) return iso(nested['generatedAt']) ?? iso(nested['observedAt']) ?? top;
    }
    return top;
  };
  return {
    pulls: pick('pulls', 'growth-pulls-1d.json', 'growth-pulls-hourly.jsonl'),
    releases: pick('releases', 'growth-releases.jsonl'),
    cost: pick('cost', 'growth-cost-hourly.jsonl'),
  };
}

function isPullRow(row: Record<string, unknown>): boolean {
  return typeof row['repo'] === 'string' && typeof row['createdAt'] === 'string' && typeof row['number'] === 'number';
}

function isCountRow(row: Record<string, unknown>): boolean {
  return finite(row['opened']) !== null || finite(row['merged']) !== null;
}

function parseHourly(lines: readonly string[]): { pulls: GrowthPull[] | null; counts: GrowthHourCount[] | null; complete: boolean } {
  const pulls: unknown[] = [];
  const counts: GrowthHourCount[] = [];
  let pullRows = 0;
  let countRows = 0;
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const row = record(parsed);
    if (!row) continue;
    if (isPullRow(row)) {
      pullRows += 1;
      pulls.push(row);
      continue;
    }
    if (!isCountRow(row)) continue;
    const at = stampOf(row, ['t', 'ts', 'at', 'hour', 'time']);
    if (at === null) continue;
    countRows += 1;
    counts.push({ at, opened: finite(row['opened']), merged: finite(row['merged']) });
  }
  if (pullRows > 0) {
    const parsed = parsePullExport({ pulls, complete: true });
    return { pulls: parsed?.pulls ?? [], counts: null, complete: true };
  }
  if (countRows > 0) return { pulls: null, counts, complete: true };
  return { pulls: null, counts: null, complete: false };
}

function parseReleases(lines: readonly string[]): { at: number }[] {
  const events: { at: number }[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const row = record(parsed);
    if (!row) continue;
    const at = iso(row['publishedAt']);
    if (!at) continue;
    events.push({ at: Date.parse(at) });
  }
  return events;
}

function parseCost(lines: readonly string[]): GrowthCostPoint[] {
  const points: GrowthCostPoint[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const row = record(parsed);
    if (!row) continue;
    const at = stampOf(row, ['t', 'ts', 'at', 'hour', 'time']);
    if (at === null) continue;
    const usd = row['costPerMergedPrUsd'];
    points.push({ at, usd: usd === null ? null : finite(usd) });
  }
  return points;
}

function usagePaths(): string[] {
  const runs = join(homedir(), '.ashlr-runs', 'queue', 'usage-readings.log');
  const home = join(process.env['ASHLR_HOME'] ?? join(homedir(), '.ashlr'), 'usage-readings.log');
  return [runs, home];
}

async function readUsage(): Promise<string | null> {
  const parts: string[] = [];
  for (const path of usagePaths()) {
    const text = await readBounded(path, USAGE_MAX_BYTES);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function scorecard(window: '7d' | '30d'): GrowthScorecard | null {
  if (!existsSync(scorecardHistoryDir())) return null;
  const trend = readScorecardTrend(window, { limit: window === '7d' ? 8 : 31 });
  if (trend.sourceQuality.sourceState === 'missing' || trend.points.length === 0) return null;
  return {
    sourceState: trend.sourceQuality.sourceState === 'degraded' ? 'degraded' : 'healthy',
    points: trend.points.map((point) => ({ ts: point.ts, costPerMergedChangeUsd: point.costPerMergedChangeUsd })),
  };
}

async function loadExports(dir: string): Promise<Pick<GrowthFacts, 'pulls' | 'pullsComplete' | 'hourlyPulls' | 'hourlyPullsComplete' | 'hourlyPullCounts' | 'releases' | 'costHourly' | 'exportClock'>> {
  const dayPath = join(dir, PULLS_DAY);
  const hourlyPath = join(dir, PULLS_HOURLY);
  const releasePath = join(dir, RELEASES);
  const costPath = join(dir, COST);
  const statusPath = join(dir, STATUS);
  const [dayJson, hourlyLines, releaseLines, costLines, statusJson, dayMtime, hourlyMtime, releaseMtime, costMtime] = await Promise.all([
    readMetricsJson(dayPath),
    readGrowthJsonl(hourlyPath),
    readGrowthJsonl(releasePath),
    readGrowthJsonl(costPath),
    readMetricsJson(statusPath),
    fileMtime(dayPath),
    fileMtime(hourlyPath),
    fileMtime(releasePath),
    fileMtime(costPath),
  ]);
  const day = dayJson === null ? null : parsePullExport(dayJson);
  const hourly = hourlyLines === null ? null : parseHourly(hourlyLines);
  const status = parseStatus(statusJson);
  const clock: GrowthExportClock = {
    pulls: status.pulls ?? hourlyMtime ?? dayMtime,
    releases: status.releases ?? releaseMtime,
    cost: status.cost ?? costMtime,
  };
  return {
    pulls: day?.pulls ?? null,
    pullsComplete: day?.complete === true,
    hourlyPulls: hourly?.pulls ?? null,
    hourlyPullsComplete: hourly?.complete === true && hourly.pulls !== null,
    hourlyPullCounts: hourly?.counts ?? null,
    releases: releaseLines === null ? null : parseReleases(releaseLines),
    costHourly: costLines === null ? null : parseCost(costLines),
    exportClock: clock,
  };
}

export async function loadGrowthFacts(options: GrowthReadOptions = {}): Promise<GrowthFacts> {
  const nowMs = options.nowMs ?? Date.now();
  const jobsPath = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
  const exports = await loadExports(metricsRoot(options));
  const [jobsText, usageText] = await Promise.all([
    options.jobsText !== undefined ? Promise.resolve(options.jobsText) : readBounded(jobsPath, JOBS_MAX_BYTES),
    options.usageText !== undefined ? Promise.resolve(options.usageText) : readUsage(),
  ]);
  return {
    nowMs,
    jobsText,
    usageText,
    pulls: options.pulls !== undefined ? options.pulls : exports.pulls,
    pullsComplete: options.pulls !== undefined ? options.pullsComplete === true : exports.pullsComplete,
    pullsSource: options.pulls !== undefined ? options.pullsSource : exports.pulls ? 'metrics/growth-pulls-1d.json' : undefined,
    hourlyPulls: options.hourlyPulls !== undefined ? options.hourlyPulls : exports.hourlyPulls,
    hourlyPullsComplete: options.hourlyPulls !== undefined ? options.hourlyPullsComplete === true : exports.hourlyPullsComplete,
    hourlyPullCounts: options.hourlyPullCounts !== undefined ? options.hourlyPullCounts : exports.hourlyPullCounts,
    releases: options.releases !== undefined ? options.releases : exports.releases,
    costHourly: options.costHourly !== undefined ? options.costHourly : exports.costHourly,
    exportClock: options.exportClock !== undefined ? options.exportClock : exports.exportClock,
    scorecard7d: options.scorecard7d !== undefined ? options.scorecard7d : scorecard('7d'),
    scorecard30d: options.scorecard30d !== undefined ? options.scorecard30d : scorecard('30d'),
  };
}

export async function readGrowthReport(options: GrowthReadOptions & { range: GrowthRange; pullsFile?: string | null }): Promise<GrowthReport | null> {
  let pulls = options.pulls;
  let pullsComplete = options.pullsComplete;
  if (options.pullsFile) {
    if (!isAbsolute(options.pullsFile)) return null;
    const parsed = parsePullExport(await readMetricsJson(options.pullsFile));
    if (!parsed) return null;
    pulls = parsed.pulls;
    pullsComplete = parsed.complete;
  }
  const facts = await loadGrowthFacts({ ...options, pulls, pullsComplete });
  return projectGrowthSeries(facts, options.range);
}
