/** Compute per-repo daily_ttg_s from red→green daily CI run pairs.
 *
 * Reads GitHub Actions schedule runs, matches each red (failing) daily run
 * to the next green (passing) one, and reports the time between their
 * `completed_at` values as `daily_ttg_s` (seconds).
 *
 * Data lives in `~/.ashlr/ci-metrics.json` — one object keyed by repo.
 * Target: 7200 seconds (2 h).
 */
import { join } from 'node:path';
import { defaultGh, type Gh } from './autopilot/github.js';
import { FLEET_REPOS } from './portfolio/restock-lint.js';
import { ashlrHome } from './cloud/store.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from './verse/preferences.js';

function metricsPath(): string { return join(ashlrHome(), 'ci-metrics.json'); }
export const DAILY_TTG_TARGET_S = 7200;

export interface CiMetricEntry {
  repo: string;
  /** Seconds between the red run's completed_at and the next green run's completed_at. null when no pair found. */
  daily_ttg_s: number | null;
  /** The most recent red run id, or null. */
  lastRedRunId: number | null;
  /** The most recent green run id, or null. */
  lastGreenRunId: number | null;
}

export interface CiMetrics {
  v: 1;
  generatedAt: string;
  target_s: number;
  repos: Record<string, CiMetricEntry>;
}

/** Read a workflow run's ISO timestamp as milliseconds. */
function parseTs(val: string): number {
  const ms = Date.parse(val);
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${val}`);
  return ms;
}

/** Compute daily_ttg_s per repo from schedule workflow runs. */
export async function computeDailyTtgS(gh: Gh = defaultGh): Promise<Record<string, CiMetricEntry>> {
  const ghStr = gh as (args: string[]) => Promise<string>;
  const results: Record<string, CiMetricEntry> = {};

  for (const name of FLEET_REPOS) {
    const repo = `ashlrai/${name}`;
    const entry: CiMetricEntry = { repo, daily_ttg_s: null, lastRedRunId: null, lastGreenRunId: null };
    try {
      const api = async (path: string) => JSON.parse(await ghStr(['api', `repos/${repo}/${path}`]));
      // Fetch schedule runs (same pagination strategy as fleet-daily-reds).
      const allRuns: Array<{ id: number; name: string; event: string; conclusion: string | null; status: string; created_at: string; completed_at: string | null; head_branch: string }> = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await api(`actions/runs?event=schedule&per_page=100&page=${page}`);
        if (!Array.isArray(batch.workflow_runs)) throw new Error('Invalid runs');
        allRuns.push(...batch.workflow_runs);
        if (batch.workflow_runs.length < 100) break;
      }
      // Filter to CI name (daily) schedule runs on master, completed status.
      const dailyRuns = allRuns
        .filter(r => r.name === 'CI' && r.event === 'schedule' && r.head_branch === 'master' && r.status === 'completed')
        .sort((a, b) => (a.completed_at || a.created_at).localeCompare(b.completed_at || b.created_at));
      if (!dailyRuns.length) {
        results[repo] = entry;
        continue;
      }

      // Track the last red run's completed_at to find the next green run.
      let lastRedTs: number | null = null;

      for (const run of dailyRuns) {
        if (run.conclusion === 'failure') {
          // This is a red run — record its completed_at.
          lastRedTs = run.completed_at ? parseTs(run.completed_at) : parseTs(run.created_at);
          entry.lastRedRunId = run.id;
        }
        if (run.conclusion === 'success' && lastRedTs !== null) {
          // This green run follows the last red run — compute the pair.
          const greenTs = run.completed_at ? parseTs(run.completed_at) : parseTs(run.created_at);
          const diff_s = Math.round((greenTs - lastRedTs) / 1000);
          if (diff_s >= 0) entry.daily_ttg_s = diff_s;
          entry.lastGreenRunId = run.id;
          // Reset: next red starts a new pair.
          lastRedTs = null;
        }
      }
    } catch { /* Failed reads stay null; errors never leak to output. */ }
    results[repo] = entry;
  }
  return results;
}

/** Validate disk data before it can be reused by the CLI. Unknown measurements stay null. */
function isCiMetrics(value: unknown): value is CiMetrics {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<CiMetrics>;
  if (data.v !== 1 || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))
    || typeof data.target_s !== 'number' || !Number.isFinite(data.target_s) || data.target_s <= 0
    || !data.repos || typeof data.repos !== 'object' || Array.isArray(data.repos)) return false;
  const validRunId = (id: unknown): boolean => id === null || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  return Object.entries(data.repos).every(([repo, entry]) => entry !== null && typeof entry === 'object'
    && entry.repo === repo
    && (entry.daily_ttg_s === null || (typeof entry.daily_ttg_s === 'number'
      && Number.isFinite(entry.daily_ttg_s) && entry.daily_ttg_s >= 0))
    && validRunId(entry.lastRedRunId) && validRunId(entry.lastGreenRunId));
}

export async function loadExistingMetrics(): Promise<CiMetrics | null> {
  try {
    const file = readPrivateFileCapped(metricsPath(), 1024 * 1024);
    if (!file || file.truncated) return null;
    const parsed: unknown = JSON.parse(file.text);
    return isCiMetrics(parsed) ? parsed : null;
  } catch { return null; }
}

export async function saveMetrics(metrics: CiMetrics): Promise<string> {
  const path = metricsPath();
  ensurePrivateDirectory(ashlrHome());
  writePrivateFileAtomic(path, JSON.stringify(metrics, null, 2));
  return path;
}
