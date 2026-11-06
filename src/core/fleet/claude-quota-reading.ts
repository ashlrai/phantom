/** Claude's own native weekly usage, persisted for the resource ledger. Holds no identity or native text. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeAccountUsageResult } from '../resources/claude-account-usage.js';
import { writePrivateFileAtomicallyAsync } from '../util/private-file-write.js';

export interface ClaudeQuotaReadingV1 {
  v: 1; observedAt: string; reason: string; fresh: boolean;
  windows: { id: string; usedPct: number; resetAt: string | null }[];
}
const MAX_BYTES = 64 * 1024;
const MAX_WINDOWS = 16;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)$/;
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const isoTime = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));

export const claudeQuotaPath = (root: string): string => join(root, 'metrics', 'claude-quota.json');

/** Copies only id, percent and reset, and only from a fresh structured reply. */
export function toClaudeQuotaReading(result: ClaudeAccountUsageResult, observedAt: string): ClaudeQuotaReadingV1 {
  const reason = typeof result.reason === 'string' ? result.reason.slice(0, 120) : 'unknown';
  if (result.quotaFresh !== true) return { v: 1, observedAt, reason, fresh: false, windows: [] };
  const windows = result.windows.flatMap(w => typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) &&
    typeof w.id === 'string' && ID.test(w.id)
    ? [{ id: w.id, usedPct: w.usedPercent, resetAt: typeof w.resetsAt === 'string' ? w.resetsAt : null }] : []);
  return { v: 1, observedAt, reason, fresh: true, windows: windows.slice(0, MAX_WINDOWS) };
}

export function parseClaudeQuotaReading(value: unknown): ClaudeQuotaReadingV1 | null {
  if (!plain(value) || !exactKeys(value, ['v', 'observedAt', 'reason', 'fresh', 'windows'])) return null;
  if (value.v !== 1 || !isoTime(value.observedAt) || typeof value.reason !== 'string' || value.reason.length > 120 ||
      typeof value.fresh !== 'boolean' || !Array.isArray(value.windows) || value.windows.length > MAX_WINDOWS) return null;
  const windows: ClaudeQuotaReadingV1['windows'] = [];
  for (const w of value.windows as unknown[]) {
    if (!plain(w) || !exactKeys(w, ['id', 'usedPct', 'resetAt'])) return null;
    if (typeof w.id !== 'string' || !ID.test(w.id) || typeof w.usedPct !== 'number' || !Number.isFinite(w.usedPct) ||
        w.usedPct < 0 || w.usedPct > 100 || (w.resetAt !== null && !isoTime(w.resetAt))) return null;
    windows.push({ id: w.id, usedPct: w.usedPct, resetAt: w.resetAt });
  }
  if (!value.fresh && windows.length) return null;
  return { v: 1, observedAt: value.observedAt, reason: value.reason, fresh: value.fresh, windows };
}

/** Missing, oversized, non-regular, symlinked or malformed files all read as null. */
export async function readClaudeQuotaReading(root: string): Promise<ClaudeQuotaReadingV1 | null> {
  let file;
  try { file = await open(claudeQuotaPath(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) return null;
    try { return parseClaudeQuotaReading(JSON.parse(buffer.subarray(0, offset).toString('utf8'))); } catch { return null; }
  } catch { return null; } finally { await file.close().catch(() => undefined); }
}

export async function writeClaudeQuotaReading(root: string, reading: ClaudeQuotaReadingV1): Promise<void> {
  const target = claudeQuotaPath(root);
  await mkdir(join(root, 'metrics'), { recursive: true, mode: 0o700 });
  await writePrivateFileAtomicallyAsync(`${target}.${randomUUID()}.tmp`, target, `${JSON.stringify(reading)}\n`, {
    anchorPath: root, label: 'claude quota reading', beforePublish: () => undefined,
  });
}

const SCOPES = new Set(['seven_day_fable', 'seven_day_opus', 'seven_day_sonnet']);
const MAX_AGE_MS = 6 * 3_600_000;

/** The all-models weekly window plus per-model scopes, or null when the reading must not be applied. */
export function usableClaudeWeekly(reading: ClaudeQuotaReadingV1 | null, now: number) {
  if (!reading?.fresh) return null;
  const at = Date.parse(reading.observedAt);
  if (!Number.isFinite(at) || at > now || now - at > MAX_AGE_MS) return null;
  const weekly = reading.windows.find(w => w.id === 'seven_day');
  if (!weekly) return null;
  return { weekly, observedAt: reading.observedAt, scopes: reading.windows.filter(w => SCOPES.has(w.id)) };
}
