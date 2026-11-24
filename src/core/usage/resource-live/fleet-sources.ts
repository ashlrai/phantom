/** Bounded, value-only reads of dispatcher observations. These never inspect credentials. */
import { join } from 'node:path';
import { readStableRegularFile } from '../../util/stable-file-read.js';
import type { ResourceLiveSource, ResourceLiveObservation } from './source-types.js';

const MAX_BYTES = 1024 * 1024;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function readJson(runsDir: string, relative: string): Record<string, unknown> | null {
  const result = readStableRegularFile(join(runsDir, relative), { anchorPath: runsDir, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!result.ok) return null;
  try { return object(JSON.parse(result.text)); } catch { return null; }
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}
function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function observation(row: Record<string, unknown>, source: string): ResourceLiveObservation | null {
  const used = percent(row['weekly_used_pct']);
  const observed = date(row['observed_at'] ?? row['as_of'] ?? row['timestamp']);
  if (used === null || observed === null || row['estimated'] === true) return null;
  return { used, limit: 100, unit: 'percent', reset_at: date(row['reset_at']), source, observed_at: observed };
}
const STATUS_SOURCES: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude-broker', 'claude-rate-limit-event'],
  'codex-personal': ['reader-1', 'codex-app-server', 'codex-app-server-rate-limits'],
  'codex-cmp': ['reader-cmp', 'codex-app-server', 'codex-app-server-rate-limits'],
  grok: ['grok-status'],
};
export function statusBudgetSource(runsDir: string, lane: string): ResourceLiveSource {
  return { tier: 'own-call', read: () => {
    const status = readJson(runsDir, 'queue/status.json');
    const row = object(object(status?.['budget'])?.[lane]);
    if (!row || typeof row['source'] !== 'string' || !STATUS_SOURCES[lane]?.includes(row['source'])) return null;
    return observation(row, `status-budget:${row['source']}`);
  } };
}

/** Grok's recorded usage files may contain a percentage or measured points. */
export function ultraReadingSource(runsDir: string, relative: string): ResourceLiveSource {
  return { tier: 'own-call', read: () => {
    const row = readJson(runsDir, relative);
    if (!row || row['estimated'] === true) return null;
    const pct = observation(row, relative);
    if (pct) return pct;
    const remaining = row['remainingPoints'], total = row['totalPoints'];
    const observed = date(row['timestamp']);
    if (typeof remaining !== 'number' || !Number.isFinite(remaining) || typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || remaining < 0 || remaining > total || !observed) return null;
    return { used: total - remaining, limit: total, unit: 'points', reset_at: date(row['reset_at']), source: relative, observed_at: observed };
  } };
}
