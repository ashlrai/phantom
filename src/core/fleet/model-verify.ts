/** Offline documentation freshness check; this does not prove account access. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ModelStatus = 'verified' | 'unverified' | 'retired';
export interface VerifiedModelRegistryEntry {
  id: string; provider: string; status: ModelStatus; verified_source: string | null; verified_at: string | null;
}
export interface ModelVerifyIssue { key: string; model: string | null; reason: 'unregistered' | 'stale' | 'invalid-model' | 'unverified' | 'retired' }
export interface ModelVerifyReport { schema: 'fleet.model-verify.v1'; issues: ModelVerifyIssue[]; error?: string }
export interface ModelVerifyOptions { runsDir?: string; registryPath?: string | URL; now?: () => number }
const ALIASES = new Set(['haiku', 'sonnet', 'opus', 'auto', 'fast', 'strong']);
const DAY = 86_400_000;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Refuse pipes/symlinks and cap reads even if a file grows during inspection. */
async function readJson(path: string | URL): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat(), max = 1024 * 1024;
    if (!info.isFile() || info.size > max) throw new Error('invalid source');
    const buffer = Buffer.alloc(max + 1);
    let size = 0, count: number;
    do { count = (await file.read(buffer, size, buffer.length - size, null)).bytesRead; size += count; }
    while (count && size <= max);
    if (size > max) throw new Error('source too large');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { await file.close(); }
}

export async function verifyFleetModels(opts: ModelVerifyOptions = {}): Promise<ModelVerifyReport> {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const models = await readJson(join(root, 'models.json'));
  if (!object(models)) throw new Error('invalid model sources');
  const now = (opts.now ?? Date.now)();
  const entries = new Map((await loadVerifiedRegistry({ ...opts, now: () => now })).map(row => [row.id, row]));
  const issues: ModelVerifyIssue[] = [];
  for (const [key, value] of Object.entries(models)) {
    // The launcher reserves these rows for reasoning effort, not model IDs.
    if (key === 'effort' || key.startsWith('effort.') || key.startsWith('mode.')) continue;
    if (typeof value !== 'string' || !value.trim()) { issues.push({ key, model: null, reason: 'invalid-model' }); continue; }
    const model = value.trim();
    if (ALIASES.has(model)) continue;
    const entry = entries.get(model);
    if (!entry) issues.push({ key, model, reason: 'unregistered' });
    else if (entry.status !== 'verified') issues.push({ key, model, reason: entry.status });
    else if (now - Date.parse(entry.verified_at!) > 30 * DAY) issues.push({ key, model, reason: 'stale' });
  }
  return { schema: 'fleet.model-verify.v1', issues };
}

/** Exact provider hosts: a URL or a successful fetch alone never verifies an ID. */
export const MODEL_SOURCE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ['learn.chatgpt.com', 'developers.openai.com', 'platform.openai.com'],
  anthropic: ['platform.claude.com'], xai: ['docs.x.ai'], zai: ['docs.z.ai'],
  qwen: ['qwenlm.github.io', 'qwen.readthedocs.io'],
};
export async function loadVerifiedRegistry(opts: ModelVerifyOptions = {}): Promise<VerifiedModelRegistryEntry[]> {
  const raw = await readJson(opts.registryPath ?? new URL('../../../docs/model-registry.json', import.meta.url));
  const now = (opts.now ?? Date.now)(), ids = new Set<string>();
  if (!Array.isArray(raw) || !Number.isFinite(now)) throw new Error('Invalid registry');
  const entries = raw.map((row: unknown) => {
    if (!object(row) || typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(row.id)
      || ids.has(row.id) || typeof row.provider !== 'string' || !row.provider.trim()
      || typeof row.status !== 'string' || !['verified', 'unverified', 'retired'].includes(row.status)) throw new Error('Invalid registry entry');
    ids.add(row.id);
    if (row.verified_source !== null) {
      if (typeof row.verified_source !== 'string') throw new Error('Invalid model source');
      const url = new URL(row.verified_source);
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !MODEL_SOURCE_HOSTS[row.provider]?.includes(url.hostname)) throw new Error('Invalid model source');
    }
    if (row.verified_at !== null) {
      if (typeof row.verified_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.verified_at)) throw new Error('Invalid verification date');
      const date = Date.parse(row.verified_at);
      if (!Number.isFinite(date) || date > now || new Date(date).toISOString().slice(0, 10) !== row.verified_at) throw new Error('Invalid verification date');
    }
    if (row.status !== 'unverified' && (!row.verified_at || !row.verified_source)) throw new Error('Missing verification evidence');
    return row as unknown as VerifiedModelRegistryEntry;
  });
  return entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Preserve the lane's offered order. Stale evidence requests review, not retirement. */
export function selectVerifiedModel(models: readonly string[], registry: readonly VerifiedModelRegistryEntry[]): { model: string | null; reason: string | null } {
  const skipped: string[] = [];
  for (const model of [...new Set(models)]) {
    const status = registry.find(entry => entry.id === model)?.status ?? 'unverified';
    if (status === 'verified') return { model, reason: skipped.length ? `${skipped.join(' ')} Using verified model ${model} on the same lane.` : null };
    skipped.push(`Skipped ${model}: ${status}.`);
  }
  return { model: null, reason: `${skipped.join(' ')} No verified model is available on this lane.`.trim() };
}

export async function verifyModelRegistry(opts: ModelVerifyOptions = {}) {
  const now = (opts.now ?? Date.now)();
  const entries = await loadVerifiedRegistry({ ...opts, now: () => now });
  const results = entries.map(({ id, provider, status, verified_source, verified_at }) => ({
    id, provider, status, verified_source, verified_at,
    age_days: verified_at === null ? null : Math.floor((now - Date.parse(verified_at)) / DAY),
    needs_recheck: verified_at === null || now - Date.parse(verified_at) > 14 * DAY,
  }));
  const report = { schema: 'models.verify.v1' as const, results, current_choices: [] as Array<{ key: string; model: string | null; status: ModelStatus }>, ok: false, error: null as string | null };
  try {
    const models = await readJson(join(opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'models.json'));
    if (!object(models)) throw new Error('Invalid choices');
    report.current_choices = Object.keys(models).sort().filter(key => key !== 'effort' && !key.startsWith('effort.') && !key.startsWith('mode.')).map(key => {
      const model = typeof models[key] === 'string' ? models[key].trim() : null;
      return { key, model, status: entries.find(entry => entry.id === model)?.status ?? 'unverified' };
    });
    report.ok = report.current_choices.every(choice => choice.status === 'verified');
  } catch { report.error = 'Cannot read or validate models.json; current router choices are unknown.'; }
  return report;
}
