/**
 * zai-usage.ts — the zai (Z.ai GLM Coding Lite) row of the "Every resource"
 * panel. zai is the one GLM Lite lane: dispatchd paces it from its own
 * included-quota window and publishes the reading as the `zai` row of
 * <runsDir>/queue/resources.json ({ used_frac, reset_at }), the same file
 * `ashlr fleet resources` reads. This reader projects that row; it never
 * touches the lane's credential or the provider.
 */
import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageResourceReading } from './resource-usage-types.js';

export const ZAI_USAGE_SOURCE = 'zai-lane-resources';

export interface ZaiUsageDeps {
  /** Runs dir; default ASHLR_RUNS_DIR then ~/.ashlr-runs. */
  runsDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readText?: (path: string) => Promise<string>;
  /** File mtime in epoch ms, or null when unreadable. */
  mtimeMs?: (path: string) => Promise<number | null>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function resetIso(value: unknown): string | null {
  const ms = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value * 1000 : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}

/** The zai window as a percent reading, or null when nothing valid is published. */
export async function readZaiUsage(deps: ZaiUsageDeps = {}): Promise<UsageResourceReading | null> {
  const runsDir = deps.runsDir ?? (deps.env ?? process.env).ASHLR_RUNS_DIR ?? join(deps.homeDir ?? homedir(), '.ashlr-runs');
  const path = join(runsDir, 'queue', 'resources.json');
  let raw: unknown;
  let mtime: number | null;
  try {
    raw = JSON.parse(await (deps.readText ?? ((p: string) => readFile(p, 'utf8')))(path));
    mtime = await (deps.mtimeMs ?? (async (p: string) => (await stat(p)).mtimeMs))(path).catch(() => null);
  } catch {
    return null;
  }
  if (!record(raw)) return null;
  const rows = record(raw.lanes) ? raw.lanes : raw;
  const row = Object.prototype.hasOwnProperty.call(rows, 'zai') ? rows.zai : undefined;
  if (!record(row)) return null;
  const frac = row.used_frac;
  if (typeof frac !== 'number' || !Number.isFinite(frac) || frac < 0 || mtime === null) return null;
  return {
    used: Math.round(Math.min(frac, 1) * 10_000) / 100,
    limit: 100,
    unit: 'percent',
    resetsAt: resetIso(row.reset_at),
    source: ZAI_USAGE_SOURCE,
    asOf: new Date(mtime).toISOString(),
  };
}
