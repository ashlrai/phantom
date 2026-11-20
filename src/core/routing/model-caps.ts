/**
 * Per-model caps inside the Claude plan. Fable (and Opus, Sonnet) can stop with
 * "You've reached your Fable limit" while the plan overall still has room, so
 * the plan percentage alone cannot say a model is out.
 *
 * Each model is capped (true), clear (false) or unknown (null). Unknown never
 * moves work: only a recorded limit message sends a job to the next model in
 * the family (Fable -> Opus -> Sonnet). A cap clears at the plan's reset time.
 *
 * Browser-safe types and pure functions up top; the small file store below.
 */
import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubPrivateText } from '../util/scrub.js';

export const MODEL_CAPS_SCHEMA = 'model-caps.v1' as const;
/** Same-family order: the first entry is tried first, later ones are the fallbacks. */
export const MODEL_FAMILY_ORDER = ['fable', 'opus', 'sonnet'] as const;
export type CapModel = (typeof MODEL_FAMILY_ORDER)[number];
/** Concrete id a fallback runs on. Update when a newer model ships. */
export const FAMILY_MODEL_ID: Readonly<Record<CapModel, string>> = {
  fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5',
};
/** A cap with no known reset (neither in the message nor from the plan) is re-checked after this long. */
export const UNKNOWN_RESET_CAP_MS = 6 * 3_600_000;

export interface ModelCapRow {
  model: CapModel;
  /** true: stopped by its own limit. false: clear. null: unknown (never recorded). */
  capped: boolean | null;
  /** When the limit message was seen; null while unknown. */
  since: string | null;
  /** When the cap clears: the plan's reset time. */
  resetAt: string | null;
  /** The last limit message, scrubbed and cut short. */
  source: string | null;
}

export const modelFamily = (id: string | null | undefined): CapModel | null =>
  MODEL_FAMILY_ORDER.find(name => (id ?? '').toLowerCase().includes(name)) ?? null;

/** "You've reached your Fable limit" -> 'fable'. Null when the text names no known model. */
export function parseLimitMessage(text: string): CapModel | null {
  const named = /reached your ([a-z][a-z0-9.-]*) limit/i.exec(text)?.[1];
  return modelFamily(named);
}

const iso = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;

/** The row for every model, with a cap whose reset has passed shown as clear. Unrecorded models are unknown. */
export function resolveModelCaps(stored: unknown, nowMs: number): ModelCapRow[] {
  const list = (stored as { caps?: unknown } | null)?.caps;
  const rows = Array.isArray(list) ? list as Record<string, unknown>[] : [];
  return MODEL_FAMILY_ORDER.map((model): ModelCapRow => {
    const row = rows.find(r => r !== null && typeof r === 'object' && r.model === model);
    if (!row || typeof row.capped !== 'boolean') return { model, capped: null, since: null, resetAt: null, source: null };
    const resetAt = iso(row.resetAt), since = iso(row.since);
    const source = typeof row.source === 'string' ? row.source : null;
    const stillCapped = row.capped && resetAt !== null && Date.parse(resetAt) > nowMs;
    return { model, capped: stillCapped, since, resetAt, source };
  });
}

/**
 * The model to run. A capped model moves to the next one in its family that is
 * not capped; `fallback_from` names the model it left. Unknown or clear: unchanged.
 * Every later model capped too: unchanged, so the job fails visibly instead of silently downgrading past Sonnet.
 */
export function applyModelCap(model: string, caps: readonly ModelCapRow[] | undefined): { model: string; fallback_from: string | null } {
  const family = modelFamily(model);
  const cap = (name: CapModel): boolean => caps?.find(row => row.model === name)?.capped === true;
  if (family === null || !cap(family)) return { model, fallback_from: null };
  const next = MODEL_FAMILY_ORDER.slice(MODEL_FAMILY_ORDER.indexOf(family) + 1).find(name => !cap(name));
  return next === undefined ? { model, fallback_from: null } : { model: FAMILY_MODEL_ID[next], fallback_from: model };
}

const capsPath = (root: string): string => join(root, 'queue', 'model-caps.json');

export async function readModelCaps(root: string, nowMs = Date.now()): Promise<ModelCapRow[]> {
  try {
    const fd = await open(capsPath(root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.size > 64 * 1024) return resolveModelCaps(null, nowMs);
      const bytes = Buffer.alloc(info.size);
      await fd.read(bytes, 0, bytes.length, 0);
      return resolveModelCaps(JSON.parse(bytes.toString('utf8')), nowMs);
    } finally { await fd.close(); }
  } catch { return resolveModelCaps(null, nowMs); }
}

/**
 * Record a limit message (or clear a model). `planResetAt` is the Claude plan's
 * reset time from the ledger; a reset named by the caller wins over it.
 */
export async function recordModelCap(root: string, input: { model: CapModel; message?: string; clear?: boolean; resetAt?: string | null; planResetAt?: string | null }, nowMs = Date.now()): Promise<ModelCapRow[]> {
  const current = await readModelCaps(root, nowMs);
  const reset = iso(input.resetAt) ?? iso(input.planResetAt);
  const resetAt = reset !== null && Date.parse(reset) > nowMs ? reset : new Date(nowMs + UNKNOWN_RESET_CAP_MS).toISOString();
  const source = input.message === undefined ? null
    : scrubPrivateText(input.message, { emails: true }).replace(/\p{Cc}/gu, ' ').trim().slice(0, 160) || null;
  const next = current.map(row => row.model !== input.model ? row
    : input.clear ? { model: row.model, capped: false, since: new Date(nowMs).toISOString(), resetAt: null, source }
      : { model: row.model, capped: true, since: new Date(nowMs).toISOString(), resetAt, source });
  await mkdir(join(root, 'queue'), { recursive: true });
  const tmp = `${capsPath(root)}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ schema: MODEL_CAPS_SCHEMA, caps: next }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, capsPath(root));
  return next;
}
