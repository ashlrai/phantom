/**
 * Storage for state/resource-live.json and resource evidence: paths, the stored shape and a
 * tolerant parser. Consumers (the world model, the scheduler) import this
 * file, not the engine, so reading the sidecar never loads a provider reader.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../../fleet/local-store-lock.js';
import { writePrivateFileAtomically } from '../../util/private-file-write.js';
import { EMPTY_RESET_STATE } from './reset-rule.js';
import { antigravityExecutionContext, antigravityGroupsSchema } from './antigravity-quota.js';
import {
  RESOURCE_LIVE_ALLOWANCES, RESOURCE_LIVE_SCHEMA, RESOURCE_LIVE_STALE_MS,
  RESOURCE_HISTORY_SCHEMA, type ResourceHistoryFile,
  type HistorySample, type PollState, type ResourceLiveAllowance, type ResourceLiveId,
  type ResourceLiveReading, type ResourceLiveReason, type ResourceLiveSidecar,
} from './types.js';

export const HISTORY_PER_ALLOWANCE = 12;
export const resourceHistoryPath = (runsDir: string): string => join(resourceLiveStateDir(runsDir), 'resource-live-history.json');
const MAX_SIDECAR_BYTES = 512 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const fileSchema = z.object({
  schema: z.literal('resource-evidence.v1'),
  readings: z.record(z.string(), z.unknown()),
});

export function resourceLiveStateDir(runsDir: string): string {
  if (!isAbsolute(runsDir) || /(?:^|\/)\.codex[^/]*(?:\/|$)/.test(runsDir)) throw new Error('resource-live runs dir refused');
  return join(runsDir, 'state');
}
export const resourceLivePath = (runsDir: string): string => join(resourceLiveStateDir(runsDir), 'resource-live.json');
export const resetDecisionDir = (runsDir: string): string => join(runsDir, 'bus', 'masbot');

const instant = z.string().refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const amount = z.number().finite().nonnegative().nullable();
const ids = RESOURCE_LIVE_ALLOWANCES.map(row => row.id) as [ResourceLiveId, ...ResourceLiveId[]];
export const resourceIdSchema = z.union([z.enum(ids),
  z.custom<`custom:${string}`>(value => typeof value === 'string' && /^custom:[a-z0-9][a-z0-9-]{0,62}$/.test(value))]);

export const readingSchema = z.object({
  groups: antigravityGroupsSchema.optional(),
  execution_context: antigravityExecutionContext.optional(),
  account_id: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  window_start: instant.optional(),
  id: resourceIdSchema,
  verified: z.boolean(),
  used: amount,
  limit: amount,
  unit: z.enum(['percent', 'acu', 'usd', 'points', 'models']).nullable(),
  reset_at: instant.nullable(),
  expires_at: instant.nullable().optional(),
  source: z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/).nullable(),
  source_tier: z.enum(['official', 'own-call', 'visible-window', 'operator-entry']).nullable(),
  observed_at: instant.nullable(),
  confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  stale_after: instant.nullable().optional(),
});
const pollSchema = z.object({
  last_polled_at: instant, next_poll_at: instant, interval_s: z.number().finite().positive(),
  active: z.boolean(), fingerprint: z.string().max(256).nullable(),
});
const sampleSchema = z.object({ observed_at: instant, used: z.number().finite().nonnegative(), reset_at: instant.nullable() });
const reasonSchema = z.enum(['no-supported-source', 'source-returned-nothing', 'source-error', 'source-timeout',
  'invalid-reading', 'needs-signin', 'non_gui_context', 'identity_mismatch', 'window-reset']);
const draftedSchema = z.object({ drafted_at: instant, window: instant }).nullable();

export function unverified(allowance: ResourceLiveAllowance, reason: ResourceLiveReason): ResourceLiveReading {
  return {
    id: allowance.id as ResourceLiveId, label: allowance.label, lane: allowance.lane, class: allowance.class, verified: false,
    ...(allowance.custom ? { custom: allowance.custom } : {}),
    used: null, limit: null, unit: null, used_pct: null, remaining: null, reset_at: null, expires_at: allowance.expires_at,
    source: null, source_tier: null, confidence: null, observed_at: null, stale_after: null, reason,
  };
}

export type StoredReading = z.infer<typeof readingSchema>;

/** Derive percent, remaining and the staleness bound from validated fields. */
export function toReading(allowance: ResourceLiveAllowance, row: StoredReading & { observed_at: string }): ResourceLiveReading {
  const measured = row.used !== null && row.limit !== null && row.limit > 0;
  return {
    id: row.id, label: allowance.label, lane: allowance.lane, class: allowance.class, verified: true,
    ...(allowance.custom ? { custom: allowance.custom } : {}),
    ...(row.account_id ? { account_id: row.account_id } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.window_start ? { window_start: row.window_start } : {}),
    ...(row.id === 'antigravity' && row.groups ? { groups: row.groups } : {}),
    ...(row.id === 'antigravity' && row.execution_context ? { execution_context: row.execution_context } : {}),
    used: row.used, limit: row.limit, unit: row.unit,
    used_pct: measured ? Math.min(100, Math.round(row.used! / row.limit! * 1000) / 10) : null,
    remaining: measured ? Math.max(0, Math.round((row.limit! - row.used!) * 1000) / 1000) : null,
    reset_at: row.reset_at, expires_at: allowance.expires_at ?? row.expires_at ?? null, source: row.source, source_tier: row.source_tier,
    confidence: row.source_tier === 'official' ? 'high' : row.source_tier === 'own-call' ? 'medium' : 'low',
    observed_at: row.observed_at,
    stale_after: new Date(Math.min(Date.parse(row.observed_at) + RESOURCE_LIVE_STALE_MS,
      row.stale_after ? Date.parse(row.stale_after) : Infinity)).toISOString(), reason: null,
  };
}

export function usable(row: StoredReading): row is StoredReading & { observed_at: string } {
  return row.verified && row.observed_at !== null && row.source !== null && row.source_tier !== null && row.unit !== null
    && !(row.unit === 'percent' && row.limit === 100 && row.used !== null && row.used > 100);
}

/** Parse a sidecar. Anything malformed is dropped, so a damaged file reads as no prior state. */
export function parseResourceLiveSidecar(raw: unknown, custom: readonly ResourceLiveAllowance[] = []): Pick<ResourceLiveSidecar, 'readings' | 'poll' | 'history' | 'reset_rule'> & { generated_at: string | null } {
  const empty = { generated_at: null, readings: [], poll: {}, history: {}, reset_rule: { ...EMPTY_RESET_STATE } };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const file = raw as Record<string, unknown>;
  if (file['schema'] !== RESOURCE_LIVE_SCHEMA) return empty;
  const catalog = new Map<string, ResourceLiveAllowance>([...RESOURCE_LIVE_ALLOWANCES, ...custom].map(item => [item.id, item]));
  const accepted = new Set<string>(ids);
  const readings: ResourceLiveReading[] = [];
  for (const row of Array.isArray(file['readings']) ? file['readings'] : []) {
    const parsed = readingSchema.safeParse(row);
    const allowance = parsed.success ? catalog.get(parsed.data.id) : undefined;
    if (!parsed.success || !allowance || readings.some(item => item.id === allowance.id)) continue;
    const stored = row as Record<string, unknown>;
    if (allowance.custom && JSON.stringify(stored['custom']) !== JSON.stringify(allowance.custom)) continue;
    accepted.add(parsed.data.id);
    if (usable(parsed.data)) readings.push(toReading(allowance, parsed.data));
    else {
      const reason = reasonSchema.safeParse((row as Record<string, unknown>)['reason']);
      readings.push({ ...unverified(allowance, reason.success ? reason.data : 'source-returned-nothing'),
        ...(allowance.id === 'antigravity' && parsed.data.execution_context ? { execution_context: parsed.data.execution_context } : {}) });
    }
  }
  const poll: Partial<Record<ResourceLiveId, PollState>> = {};
  const history: Partial<Record<ResourceLiveId, HistorySample[]>> = {};
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  for (const id of accepted as Set<ResourceLiveId>) {
    const state = pollSchema.safeParse(record(file['poll'])[id]);
    if (state.success) poll[id] = state.data;
    const rows = record(file['history'])[id];
    if (Array.isArray(rows)) {
      const kept = rows.flatMap(row => { const sample = sampleSchema.safeParse(row); return sample.success ? [sample.data] : []; });
      if (kept.length) history[id] = kept.slice(-HISTORY_PER_ALLOWANCE);
    }
  }
  const rule = record(file['reset_rule']);
  const fable = draftedSchema.safeParse(rule['fable'] ?? null);
  const weekly = draftedSchema.safeParse(rule['weekly'] ?? null);
  const generated = instant.safeParse(file['generated_at']);
  return {
    generated_at: generated.success ? generated.data : null, readings, poll, history,
    reset_rule: {
      fable: fable.success ? fable.data : null,
      weekly: weekly.success ? weekly.data : null,
      last_decision_file: typeof rule['last_decision_file'] === 'string' ? rule['last_decision_file'].slice(0, 256) : null,
    },
  };
}

/** Read the sidecar as stored. Missing, oversized, symlinked or malformed files read as null. */
export async function readResourceLiveFile(runsDir: string): Promise<unknown | null> {
  return readPrivateJson(resourceLivePath(runsDir), MAX_SIDECAR_BYTES);
}

export async function readResourceEvidenceFile(runsDir: string): Promise<unknown | null> {
  return readPrivateJson(join(resourceLiveStateDir(runsDir), 'resource-evidence.json'), MAX_EVIDENCE_BYTES);
}

export async function updateEvidence<T>(runsDir: string, update: (readings: Record<string, unknown>) => Promise<{ changed: boolean; result: T }>): Promise<T | null> {
  const state = resourceLiveStateDir(runsDir);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const path = join(state, 'resource-evidence.json');
  const lock = acquireLocalStoreLock(join(state, 'resource-evidence.lock'), 0, { anchorPath: runsDir });
  if (!lock) return null;
  try {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const stored = existing ? fileSchema.safeParse(await readPrivateJson(path, MAX_EVIDENCE_BYTES)) : null;
    if (stored && !stored.success) throw new Error('Invalid existing resource-evidence.v1 file.');
    const readings = stored?.data.readings ?? {};
    const { changed, result } = await update(readings);
    if (changed) {
      const body = JSON.stringify({ schema: 'resource-evidence.v1', readings }) + '\n';
      if (Buffer.byteLength(body) > MAX_EVIDENCE_BYTES) throw new Error('Resource evidence exceeds the sidecar limit.');
      writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path, body, { anchorPath: runsDir, label: 'Resource evidence' });
    }
    return result;
  } finally {
    releaseLocalStoreLock(lock);
  }
}

export async function readResourceHistoryFile(runsDir: string): Promise<unknown | null> {
  return readPrivateJson(resourceHistoryPath(runsDir), 8 * 1024 * 1024);
}

export async function readPrivateJson(path: string, cap: number): Promise<unknown | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > cap) return null;
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch { return null; } finally { await handle.close().catch(() => undefined); }
}

const historyPointSchema = readingSchema.pick({ unit: true, reset_at: true, source_tier: true }).extend({
  observed_at: instant, used: z.number().finite().nonnegative(), limit: z.number().finite().nonnegative(),
  left: amount, source: readingSchema.shape.source.unwrap(), confidence: z.enum(['high', 'medium', 'low']).nullable(),
});
export function parseResourceHistory(raw: unknown, nowMs = Date.now()): ResourceHistoryFile {
  const result: ResourceHistoryFile = { schema: RESOURCE_HISTORY_SCHEMA, allowances: {} };
  const file = z.object({ schema: z.literal(RESOURCE_HISTORY_SCHEMA), allowances: z.record(z.string(), z.unknown()) }).safeParse(raw);
  if (!file.success) return result;
  for (const id of ids) {
    const rows = file.data.allowances[id];
    if (!Array.isArray(rows)) continue;
    const points = rows.flatMap(row => { const p = historyPointSchema.safeParse(row); return p.success ? [p.data] : []; })
      .filter(p => Date.parse(p.observed_at) >= nowMs - 7 * 24 * 3_600_000 && Date.parse(p.observed_at) <= nowMs)
      .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
    const kept = points.filter((p, i) => i === 0 || p.observed_at !== points[i - 1]!.observed_at).slice(-2016);
    if (kept.length) result.allowances[id] = kept;
  }
  return result;
}

export function appendResourceHistory(raw: unknown, readings: readonly ResourceLiveReading[], nowMs: number): ResourceHistoryFile {
  const file = parseResourceHistory(raw, nowMs);
  for (const r of readings) {
    if (r.custom || !r.verified || r.used === null || r.limit === null || r.observed_at === null || r.source === null) continue;
    const points = file.allowances[r.id] ?? [];
    const last = points.at(-1);
    const at = Date.parse(r.observed_at);
    if (at > nowMs || at < nowMs - 7 * 24 * 3_600_000 || (last && at - Date.parse(last.observed_at) < 300_000)) continue;
    points.push({ observed_at: r.observed_at, used: r.used, left: r.remaining, limit: r.limit, unit: r.unit,
      reset_at: r.reset_at, source: r.source, source_tier: r.source_tier, confidence: r.confidence });
    file.allowances[r.id] = points.slice(-2016);
  }
  return file;
}
