/** Offline documentation freshness check; this does not prove account access. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ModelRegistryEntry { id: string; provider: string; docs_url: string; verified: string }
export interface ModelVerifyIssue { key: string; model: string | null; reason: 'unregistered' | 'stale' | 'invalid-model' }
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
  const registry = await readJson(opts.registryPath ?? new URL('../../../docs/model-registry.json', import.meta.url));
  if (!object(models) || !Array.isArray(registry)) throw new Error('invalid model sources');
  const now = (opts.now ?? Date.now)();
  if (!Number.isFinite(now)) throw new Error('invalid clock');
  const entries = new Map<string, ModelRegistryEntry>();
  for (const row of registry) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim() || entries.has(row.id)
      || typeof row.provider !== 'string' || !row.provider.trim() || typeof row.docs_url !== 'string'
      || typeof row.verified !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.verified)) throw new Error('invalid registry entry');
    const date = Date.parse(row.verified);
    const url = new URL(row.docs_url);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== row.verified || date > now
      || url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid registry evidence');
    entries.set(row.id, { id: row.id, provider: row.provider, docs_url: row.docs_url, verified: row.verified });
  }
  const issues: ModelVerifyIssue[] = [];
  for (const [key, value] of Object.entries(models)) {
    // The launcher reserves these rows for reasoning effort, not model IDs.
    if (key === 'effort' || key.startsWith('effort.')) continue;
    if (typeof value !== 'string' || !value.trim()) { issues.push({ key, model: null, reason: 'invalid-model' }); continue; }
    const model = value.trim();
    if (ALIASES.has(model)) continue;
    const entry = entries.get(model);
    if (!entry) issues.push({ key, model, reason: 'unregistered' });
    else if (now - Date.parse(entry.verified) > 30 * DAY) issues.push({ key, model, reason: 'stale' });
  }
  return { schema: 'fleet.model-verify.v1', issues };
}
