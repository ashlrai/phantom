/**
 * Read the local ledgers the growth series can actually see.
 * Missing files stay null. This module does not call gh.
 */
import { lstat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readScorecardTrend } from '../fleet/scorecard.js';
import { scorecardHistoryDir } from '../fleet/scorecard-history.js';
import { parsePullExport, type PullFact } from '../observe/pulls.js';
import { readJsonFile } from '../observe/read.js';
import {
  projectGrowthSeries,
  type GrowthFacts,
  type GrowthRange,
  type GrowthReport,
  type GrowthScorecard,
} from './series.js';

const JOBS_MAX_BYTES = 32 * 1024 * 1024;
const USAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface GrowthReadOptions {
  nowMs?: number;
  pulls?: readonly PullFact[] | null;
  pullsComplete?: boolean;
  jobsText?: string | null;
  usageText?: string | null;
  scorecard7d?: GrowthScorecard | null;
  scorecard30d?: GrowthScorecard | null;
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

export async function loadGrowthFacts(options: GrowthReadOptions = {}): Promise<GrowthFacts> {
  const nowMs = options.nowMs ?? Date.now();
  const jobsPath = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
  const [jobsText, usageText] = await Promise.all([
    options.jobsText !== undefined ? Promise.resolve(options.jobsText) : readBounded(jobsPath, JOBS_MAX_BYTES),
    options.usageText !== undefined ? Promise.resolve(options.usageText) : readUsage(),
  ]);
  return {
    nowMs,
    jobsText,
    usageText,
    pulls: options.pulls ?? null,
    pullsComplete: options.pullsComplete === true,
    scorecard7d: options.scorecard7d !== undefined ? options.scorecard7d : scorecard('7d'),
    scorecard30d: options.scorecard30d !== undefined ? options.scorecard30d : scorecard('30d'),
  };
}

export async function readGrowthReport(options: GrowthReadOptions & { range: GrowthRange; pullsFile?: string | null }): Promise<GrowthReport | null> {
  let pulls = options.pulls ?? null;
  let pullsComplete = options.pullsComplete === true;
  if (options.pullsFile) {
    const parsed = parsePullExport(await readJsonFile(options.pullsFile));
    if (!parsed) return null;
    pulls = parsed.pulls;
    pullsComplete = parsed.complete;
  }
  const facts = await loadGrowthFacts({ ...options, pulls, pullsComplete });
  return projectGrowthSeries(facts, options.range);
}
