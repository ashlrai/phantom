/**
 * lane-models-write.ts — RQ-PHX-LANEMODELSETVERB01: the write path behind
 * `phm fleet lane-model-set`. The Mac launcher (~/.ashlr-runs/bin/launch.sh)
 * resolves a worker's model as the first non-empty of <lane>.<tier>, <lane>,
 * <family>.<tier>, <family> in <runsDir>/models.json — a flat, schema-less
 * string map that Python and shell also read, and that until now only a hand
 * edit on the Mac could change. Resolution semantics are imported from
 * lane-models.ts (the read side), never copied. The write follows the same
 * guarded pattern as runs-lane-hold.ts: lstat + owner + nlink 1 + size cap,
 * a descriptor-bound O_NOFOLLOW read, a `.models-<uuid>.tmp` sibling written
 * in the file's own mode and renamed over it, then one O_APPEND|O_NOFOLLOW
 * audit row in queue/lane-models.log. Every key the change does not name —
 * effort.<lane>.<tier> rows, unknown rows, invalid rows — is preserved in
 * order, and the rewrite is 2-space JSON with a trailing newline.
 */
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseModelsJson, resolveLaneModel } from './lane-models.js';
import { LANE_ID_RE } from './runs-lane-targets.js';

/** Tiers a change resolves for its lane — the launcher's worker-pool tiers. */
const RESOLVED_TIERS = ['frontier', 'work', 'mid', 'fast'] as const;
/** Tier suffix of a `<lane>.<tier>` key — stricter than the reader's TIER_RE. */
const TIER_KEY_RE = /^[a-z][a-z0-9-]{0,20}$/;
/** The launcher's own model-id check (launch.sh): anything else fails at launch. */
export const LANE_MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX = 64 * 1024;

export type LaneModelWriteCode = 'key-shape' | 'model-shape' | 'models-missing' | 'models-invalid' | 'no-change' | 'key-missing';
export class LaneModelWriteError extends Error {
  readonly status: 422 | 503;
  constructor(readonly code: LaneModelWriteCode) {
    super({
      'key-shape': 'Key must be <lane> or <lane>.<tier> (effort.* keys are not model rows)',
      'model-shape': 'Model id must match the launcher check ^[A-Za-z0-9._-]{1,64}$',
      'models-missing': 'models.json not found',
      'models-invalid': 'models.json is unreadable or not a JSON object',
      'no-change': 'Key already carries that model',
      'key-missing': 'Key is not present in models.json',
    }[code]);
    this.name = 'LaneModelWriteError';
    this.status = code === 'models-missing' || code === 'models-invalid' ? 503 : 422;
  }
}
export interface LaneModelTierResolution { tier: string; model: string | null; via: string | null }
export interface LaneModelChangeV1 {
  v: 1; generatedAt: string; applied: boolean; key: string;
  before: string | null; after: string | null; resolved: LaneModelTierResolution[];
}
export interface LaneModelSetInput { key: string; model: string | null; reason?: string; dryRun?: boolean }
export interface LaneModelWriteOptions { runsDir?: string; modelsPath?: string; now?: () => Date; changedBy?: string }

/**
 * `<lane>` or `<lane>.<tier>` — anything else is not a settable model key:
 * effort.<lane>.<tier> rows, deep or empty segments, bad shapes. `effort`
 * itself is a reserved prefix, never a lane.
 */
export function parseLaneModelKey(raw: string): { lane: string; tier: string | null } | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length > 2) return null;
  const [lane, tier] = parts;
  if (!LANE_ID_RE.test(lane) || lane === 'effort') return null;
  if (parts.length === 1) return { lane, tier: null };
  return TIER_KEY_RE.test(tier) ? { lane, tier } : null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const errno = (error: unknown): LaneModelWriteError =>
  error instanceof LaneModelWriteError ? error
    : new LaneModelWriteError(object(error) && error.code === 'ENOENT' ? 'models-missing' : 'models-invalid');
/** Log-field hygiene: control characters stripped, field capped. */
const field = (value: string, max: number): string => value.replace(/[\x00-\x1F\x7F]/g, '').slice(0, max);

/** Read + parse models.json under the same guards as the slots writers. */
async function readModels(path: string): Promise<{ raw: Record<string, unknown>; map: Map<string, string>; mode: number }> {
  let stat: Stats;
  try { stat = await lstat(path); } catch (error) { throw errno(error); }
  if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || stat.size > MAX) throw new LaneModelWriteError('models-invalid');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: unknown) => { throw errno(error); });
  try {
    const current = await handle.stat();
    if (!current.isFile() || !owned(current) || current.nlink !== 1 || current.size > MAX ||
        current.ino !== stat.ino || current.dev !== stat.dev) throw new LaneModelWriteError('models-invalid');
    const bytes = Buffer.alloc(MAX + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX) throw new LaneModelWriteError('models-invalid');
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new LaneModelWriteError('models-invalid'); }
    if (!object(parsed)) throw new LaneModelWriteError('models-invalid');
    const { map } = parseModelsJson(bytes.subarray(0, length).toString('utf8'));
    return { raw: parsed, map, mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}

/**
 * Set (`model` string) or unset (`model` null) one `<lane>[.<tier>]` key.
 * `resolved` always reports the map's post-change state for the key's lane —
 * on a dry run it is the exact outcome a launch would see. Writes nothing
 * when `input.dryRun`; the audit row lands only on an applied change.
 */
export async function setLaneModel(input: LaneModelSetInput, opts: LaneModelWriteOptions = {}): Promise<LaneModelChangeV1> {
  const parsed = parseLaneModelKey(input.key);
  if (!parsed) throw new LaneModelWriteError('key-shape');
  const key = parsed.tier ? `${parsed.lane}.${parsed.tier}` : parsed.lane;
  const model = input.model;
  if (model !== null && (typeof model !== 'string' || !LANE_MODEL_ID_RE.test(model))) throw new LaneModelWriteError('model-shape');
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const modelsPath = opts.modelsPath ?? join(runsDir, 'models.json');
  if (!isAbsolute(runsDir) || !isAbsolute(modelsPath)) throw new LaneModelWriteError('models-invalid');
  let temp: string | undefined;
  try {
    const { raw, map, mode } = await readModels(modelsPath);
    const hasKey = Object.hasOwn(raw, key);
    const current = hasKey ? raw[key] : undefined;
    const before = typeof current === 'string' ? current : current === undefined ? null : JSON.stringify(current) ?? null;
    if (model === null && !hasKey) throw new LaneModelWriteError('key-missing');
    if (model !== null && current === model) throw new LaneModelWriteError('no-change');
    // Post-change map = the reader's own parse with exactly this key applied.
    if (model === null) { delete raw[key]; map.delete(key); } else { raw[key] = model; map.set(key, model); }
    const resolved = RESOLVED_TIERS.map(tier =>
      ({ tier, ...(resolveLaneModel(map, parsed.lane, tier) ?? { model: null, via: null }) }));
    const iso = (opts.now ?? (() => new Date()))().toISOString();
    const change: LaneModelChangeV1 = { v: 1, generatedAt: iso, applied: false, key, before, after: model, resolved };
    if (input.dryRun) return change;
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX) throw new LaneModelWriteError('models-invalid');
    // The audit row lives beside the models file's own queue dir so a --models
    // fixture never writes into the real runs dir.
    const dir = dirname(modelsPath);
    const queue = join(dir, 'queue');
    await mkdir(queue, { recursive: true, mode: 0o700 });
    const queueStat = await lstat(queue);
    if (!queueStat.isDirectory() || !owned(queueStat)) throw new LaneModelWriteError('models-invalid');
    const log = await open(join(queue, 'lane-models.log'),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await log.stat();
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new LaneModelWriteError('models-invalid');
      temp = join(dir, `.models-${randomUUID()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      try { await handle.writeFile(text); } finally { await handle.close(); }
      await rename(temp, modelsPath);
      temp = undefined;
      const str = (v: unknown): string => typeof v === 'string' ? v : '';
      const by = field(str(opts.changedBy) || 'phm fleet lane-model-set', 80);
      await log.writeFile(`${iso}\t${key}\t${field(before ?? '-', 200)}\t${model ?? '-'}\t${by}\t${field(str(input.reason), 200)}\n`);
    } finally { await log.close(); }
    return { ...change, applied: true };
  } catch (error) {
    throw errno(error);
  } finally { if (temp) await unlink(temp).catch(() => {}); }
}
