/** IO for lane-usage-self: sanctioned readers, jobs.jsonl accounting and the overrides file. */
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readLatestClaudeRateLimitEvent } from './claude-rate-limit-event.js';
import { readCodexUsage } from './readers/codex-usage.js';
import { readDevinUsage } from './readers/devin-usage.js';
import { parseClaudeUsage } from './status-readings.js';
import { readClaudeQuotaReading, usableClaudeWeekly } from '../fleet/claude-quota-reading.js';
import {
  DEFAULT_MAX_AGE_MS, parseJobRows, refreshLanes,
  type JobRow, type RefreshResult, type SanctionedReader, type SelfLane, type SelfState,
} from './lane-usage-self.js';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_JOBS_TAIL = 4 * 1024 * 1024;

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, 'utf8');
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Last 4 MiB of jobs.jsonl: enough for a week of finish rows without reading an unbounded log. */
export async function readJobRows(runsDir: string): Promise<JobRow[]> {
  const path = join(runsDir, 'metrics', 'jobs.jsonl');
  try {
    const size = (await stat(path)).size;
    const text = await readFile(path, 'utf8');
    const tail = size > MAX_JOBS_TAIL ? text.slice(text.length - MAX_JOBS_TAIL) : text;
    return parseJobRows(size > MAX_JOBS_TAIL ? tail.slice(tail.indexOf('\n') + 1) : tail);
  } catch { return []; }
}

export interface ReaderOptions {
  runsDir: string;
  /** Explicit personal-pool Codex HOME. Absent means codex-personal has no sanctioned reader (never ~/.codex). */
  codexHome?: string;
  nowMs: () => number;
  /** Loopback oMLX models URL. Fixed host; nothing else is ever fetched. */
  omlxUrl?: string;
  fetchImpl?: typeof fetch;
}

export function defaultReaders(o: ReaderOptions): Partial<Record<SelfLane, SanctionedReader>> {
  const readers: Partial<Record<SelfLane, SanctionedReader>> = {
    // Claude: Phantom's own parsed `/usage` reading, else its sanitized stream-json rate_limit_event store.
    claude: async () => {
      const now = o.nowMs();
      const weekly = usableClaudeWeekly(await readClaudeQuotaReading(o.runsDir), now);
      if (weekly) return { pctUsed: weekly.weekly.usedPct, resetAt: weekly.weekly.resetAt, source: 'claude-usage-reading' };
      const ev = parseClaudeUsage(readLatestClaudeRateLimitEvent({ nowMs: now }), now);
      return ev.pctUsed === null ? null : { pctUsed: ev.pctUsed, resetAt: ev.resetAt, source: 'claude-rate-limit-event' };
    },
    devin: async () => {
      const r = await readDevinUsage();
      if ('status' in r) return null;
      return { pctUsed: r.pctUsed, resetAt: r.resetAt, limit: r.acuLimit,
        creditsRemaining: Math.max(0, r.acuLimit - r.acuUsed), source: r.source };
    },
    // Z.ai: the fleet's own resources.json row (`used_frac`, `reset_at`), only while the file is fresh.
    zai: async () => {
      const path = join(o.runsDir, 'queue', 'resources.json');
      const mtime = (await stat(path)).mtimeMs;
      if (o.nowMs() - mtime > DEFAULT_MAX_AGE_MS) return null;
      const row = (await readJson(path))['zai'];
      const r = row && typeof row === 'object' ? row as Record<string, unknown> : {};
      const frac = r['used_frac'];
      if (typeof frac !== 'number' || !Number.isFinite(frac) || frac < 0 || frac > 1 || typeof r['reset_at'] !== 'string') return null;
      return { pctUsed: Math.round(frac * 1000) / 10, resetAt: r['reset_at'], source: 'resources.json:zai' };
    },
    // oMLX is local capacity: it has no quota and nothing resets. A reachable loopback with listed
    // models is "capacity present" (reported as model count, no percent and no reset.
    omlx: async () => {
      const f = o.fetchImpl ?? fetch;
      const res = await f(o.omlxUrl ?? 'http://127.0.0.1:8123/v1/models', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const body = await res.json() as { data?: unknown };
      const n = Array.isArray(body.data) ? body.data.length : 0;
      return n > 0 ? { pctUsed: null, resetAt: null, creditsRemaining: n, source: 'omlx-loopback-models' } : null;
    },
  };
  if (o.codexHome) {
    const home = o.codexHome;
    readers['codex-personal'] = async () => {
      const r = await readCodexUsage({ home });
      return r.pctUsed === null ? null : { pctUsed: r.pctUsed, resetAt: r.resetAt, source: 'codex-app-server-rate-limits' };
    };
  }
  return readers;
}

/** Run one refresh pass against a runs dir and atomically rewrite budget-overrides.json. */
export async function runSelfRefresh(o: ReaderOptions & { lanes?: readonly SelfLane[]; dryRun?: boolean;
  readers?: Partial<Record<SelfLane, SanctionedReader>> }): Promise<RefreshResult> {
  const overridesPath = join(o.runsDir, 'queue', 'budget-overrides.json');
  const statePath = join(o.runsDir, 'metrics', 'usage-self.state.json');
  const size = await stat(overridesPath).then(s => s.size, () => 0);
  if (size > MAX_FILE) throw new Error('budget-overrides.json too large');
  const result = await refreshLanes({
    overrides: await readJson(overridesPath), state: await readJson(statePath) as SelfState,
    rows: await readJobRows(o.runsDir), nowMs: o.nowMs(), readers: o.readers ?? defaultReaders(o),
    ...(o.lanes ? { lanes: o.lanes } : {}),
  });
  if (!o.dryRun) {
    // Re-read just before writing so a concurrent writer's other keys are not lost.
    const fresh = await readJson(overridesPath);
    for (const out of result.outcomes) {
      if (out.action !== 'kept') fresh[out.lane] = result.overrides[out.lane];
    }
    await atomicWrite(overridesPath, fresh);
    await atomicWrite(statePath, result.state);
  }
  return result;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
