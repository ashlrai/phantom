/**
 * Per-model usage caps seen in worker logs (RQ-LIMITMSGN21EQ8).
 *
 * A model can hit its own cap while the whole plan has room ("You've reached your Fable limit"). The mark lives
 * in `<runs>/metrics/model-caps.json`: `{model, capped_at, source:"worker-log"}` plus the lane and, when known,
 * the lane's reset time. A mark ends at that reset time or at the first later success on the same model.
 * The router asks `pickModel` and gets the next model in the lane, with the reason, never a silent skip.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { detectPoolCap } from './empty-why-classify.js';

export const MODEL_CAPS_SCHEMA = 'model-caps.v1';
export interface ModelCap { model: string; capped_at: string; source: 'worker-log'; lane: string; reset_at: string | null }
export interface ModelCapsFile { schema: typeof MODEL_CAPS_SCHEMA; caps: ModelCap[] }

/** Models of a lane from strongest to lightest; a tier starts at its own entry and falls toward the end. */
export const LANE_MODEL_CHAINS: Record<string, Record<string, readonly string[]>> = {
  claude: { frontier: ['fable', 'opus', 'sonnet'], work: ['opus', 'sonnet'], light: ['sonnet'] },
};

const SAFE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const modelCapsPath = (runsDir: string): string => join(runsDir, 'metrics', 'model-caps.json');

const time = (value: string | null): number => (value ? Date.parse(value) : NaN);

/** Pure: a cap still holds until its reset time, and never past a later success on that model. */
export function activeCaps(caps: readonly ModelCap[], now: number, lastSuccess: Readonly<Record<string, number>> = {}): ModelCap[] {
  return caps.filter(cap => {
    const reset = time(cap.reset_at);
    if (Number.isFinite(reset) && reset <= now) return false;
    return !((lastSuccess[cap.model] ?? 0) > time(cap.capped_at));
  });
}

/** Pure: read one finished worker's log. Returns the new mark, or null when the log shows no cap or names no model. */
export function capFromLog(log: string | null, lane: string, now: number, resetAt: string | null = null): ModelCap | null {
  const hit = detectPoolCap(log);
  if (!hit?.model || !SAFE.test(hit.model)) return null;
  return { model: hit.model, capped_at: new Date(now).toISOString(), source: 'worker-log', lane, reset_at: resetAt };
}

/** Pure: add a mark, replacing an older one for the same lane and model. */
export function addCap(caps: readonly ModelCap[], cap: ModelCap): ModelCap[] {
  return [...caps.filter(c => !(c.lane === cap.lane && c.model === cap.model)), cap];
}

/** Pure: a success on a model ends its mark. */
export function clearOnSuccess(caps: readonly ModelCap[], lane: string, model: string): ModelCap[] {
  return caps.filter(c => !(c.lane === lane && c.model === model.toLowerCase()));
}

export interface ModelPick { model: string | null; requested: string | null; skipped: Array<{ model: string; reason: string }>; known: boolean }

/** Pure: the model to launch for a tier. Capped models are skipped and each skip carries its plain-words reason. */
export function pickModel(lane: string, tier: string, caps: readonly ModelCap[], now: number, lastSuccess: Readonly<Record<string, number>> = {}): ModelPick {
  const chain = LANE_MODEL_CHAINS[lane]?.[tier];
  if (!chain) return { model: null, requested: null, skipped: [], known: false };
  const live = activeCaps(caps.filter(c => c.lane === lane), now, lastSuccess);
  const skipped: ModelPick['skipped'] = [];
  for (const model of chain) {
    const cap = live.find(c => c.model === model);
    if (!cap) return { model, requested: chain[0]!, skipped, known: true };
    skipped.push({ model, reason: `${model} hit its usage limit at ${cap.capped_at}${cap.reset_at ? `, resets ${cap.reset_at}` : ''}` });
  }
  return { model: null, requested: chain[0]!, skipped, known: true };
}

export async function readModelCaps(runsDir: string): Promise<ModelCap[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(modelCapsPath(runsDir), 'utf8'));
    const list = (parsed as ModelCapsFile | null)?.caps;
    if (!Array.isArray(list)) return null;
    return list.filter((c): c is ModelCap => !!c && typeof c.model === 'string' && SAFE.test(c.model) && typeof c.lane === 'string' && Number.isFinite(time(c.capped_at)));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

export async function writeModelCaps(runsDir: string, caps: readonly ModelCap[]): Promise<void> {
  const path = modelCapsPath(runsDir);
  await mkdir(join(runsDir, 'metrics'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ schema: MODEL_CAPS_SCHEMA, caps } satisfies { schema: string; caps: readonly ModelCap[] }) + '\n', { flag: 'wx' });
  await rename(temp, path);
}

/** Record a cap from a finished worker's log. Returns the mark, or null when nothing was recorded. */
export async function recordCapFromLog(runsDir: string, log: string | null, lane: string, now: number, resetAt: string | null = null): Promise<ModelCap | null> {
  const cap = capFromLog(log, lane, now, resetAt);
  if (!cap) return null;
  const current = await readModelCaps(runsDir);
  if (current === null) return null; // an unreadable ledger is left alone, never overwritten
  await writeModelCaps(runsDir, addCap(activeCaps(current, now), cap));
  return cap;
}

/** Record a success on a model; its mark, if any, is removed. */
export async function recordModelSuccess(runsDir: string, lane: string, model: string): Promise<boolean> {
  const current = await readModelCaps(runsDir);
  if (!current) return false;
  const next = clearOnSuccess(current, lane, model);
  if (next.length === current.length) return false;
  await writeModelCaps(runsDir, next);
  return true;
}

/** Marks that still hold, from the fleet runs dir. Empty when the file is missing or unreadable (nothing is skipped on unknown). */
export async function readLiveCaps(now: number, runsDir?: string): Promise<ModelCap[]> {
  const dir = runsDir ?? (await import('../metrics/loop-collect.js')).runsRoot();
  return activeCaps(await readModelCaps(dir) ?? [], now);
}
