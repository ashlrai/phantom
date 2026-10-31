/** Portable routine placement. Placement never grants dispatch or spending authority. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { record, exact, identifier, timestamp, safeJson } from '../resources/grokbot/contract.js';
import { privateDirectory, readJson } from '../resources/grokbot/ledger.js';
import { writePrivateFileAtomicallyAsync } from '../util/private-file-write.js';
import { withAutomationsLock } from './store.js';
import { parseRrule } from './rrule.js';

export interface Routine {
  id: string; schedule: string; prompt: string; capabilities: string[];
  last_ledger_state: { provider: string | null; at: string; reason: 'placed' | 'unavailable' } | null;
}
export interface RoutineProbe {
  health: 'ready' | 'unhealthy'; quota_state: 'available' | 'low' | 'exhausted' | 'unknown';
  reset_at: string | null; observed_at: string; expires_at: string;
  cost: number; capabilities: string[];
}
/** Every provider/account implements the same evidence boundary; no company/model switch. */
export interface RoutineAdapter { id: string; probe(now: Date): Promise<RoutineProbe> }
export const GROKBOT_NEXT_RESET = '2026-11-01T00:00:00.000Z';
const root = (): string => join(ashlrHome(), 'routines');
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 && v.every(identifier) && new Set(v).size === v.length;
function invalid(): never { throw new Error('Invalid routine document or provider evidence.'); }
export function parseRoutines(value: unknown): Routine[] {
  safeJson(value);
  if (!record(value) || !exact(value, ['schema', 'routines']) || value.schema !== 'phantom-routines.v1' ||
      !Array.isArray(value.routines) || value.routines.length > 50) invalid();
  const rows = value.routines.map((r: unknown) => {
    if (!record(r) || !exact(r, ['id', 'schedule', 'prompt', 'capabilities', 'last_ledger_state']) ||
        !identifier(r.id) || typeof r.schedule !== 'string' || !parseRrule(r.schedule).ok ||
        typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 4000 || !strings(r.capabilities)) invalid();
    const s = r.last_ledger_state;
    if (s !== null && (!record(s) || !exact(s, ['provider', 'at', 'reason']) ||
        !(s.provider === null || identifier(s.provider)) || !timestamp(s.at) ||
        !['placed', 'unavailable'].includes(String(s.reason)) || (s.reason === 'placed') !== (s.provider !== null))) invalid();
    return structuredClone(r) as unknown as Routine;
  });
  if (new Set(rows.map(r => r.id)).size !== rows.length) invalid();
  return rows;
}
export function parseRoutineProbe(value: unknown, now: Date): RoutineProbe {
  if (!record(value) || !exact(value, ['health', 'quota_state', 'reset_at', 'observed_at', 'expires_at', 'cost', 'capabilities']) ||
      !['ready', 'unhealthy'].includes(String(value.health)) ||
      !['available', 'low', 'exhausted', 'unknown'].includes(String(value.quota_state)) ||
      !(value.reset_at === null || timestamp(value.reset_at)) || !timestamp(value.observed_at) || !timestamp(value.expires_at) ||
      Date.parse(value.observed_at) > now.getTime() || Date.parse(value.expires_at) <= now.getTime() ||
      Date.parse(value.expires_at) - Date.parse(value.observed_at) > 300_000 ||
      typeof value.cost !== 'number' || !Number.isFinite(value.cost) || value.cost < 0 || !strings(value.capabilities)) invalid();
  return structuredClone(value) as unknown as RoutineProbe;
}
/** A local collector publishes credential-free evidence through this adapter.
 * Exhaustion is never cleared by the clock alone: a fresh probe must confirm reset. */
export function routineAdapter(id: string, probe: () => Promise<unknown>): RoutineAdapter {
  if (!identifier(id)) invalid();
  return { id, probe: async now => parseRoutineProbe(await probe(), now) };
}
export function grokbotAdapter(probe: () => Promise<unknown>): RoutineAdapter {
  return routineAdapter('grokbot', async () => {
    const evidence = await probe();
    return record(evidence) && evidence.reset_at === undefined ? { ...evidence, reset_at: GROKBOT_NEXT_RESET } : evidence;
  });
}
export async function rebalanceRoutines(rows: Routine[], adapters: RoutineAdapter[], now = new Date()): Promise<Routine[]> {
  if (new Set(adapters.map(a => a.id)).size !== adapters.length || adapters.some(a => !identifier(a.id))) invalid();
  const results = await Promise.all(adapters.map(async adapter => {
    try { return { id: adapter.id, evidence: parseRoutineProbe(await adapter.probe(now), now) }; }
    catch { return null; } // Unreachable or stale providers cannot receive placement.
  }));
  return rows.map(row => {
    const eligible = results.filter(item => item !== null && item.evidence.health === 'ready' &&
      item.evidence.quota_state === 'available' && row.capabilities.every(c => item.evidence.capabilities.includes(c)) &&
      // A pre-reset observation cannot establish post-reset capacity.
      !(item.evidence.reset_at && Date.parse(item.evidence.reset_at) <= now.getTime() &&
        Date.parse(item.evidence.observed_at) < Date.parse(item.evidence.reset_at)));
    eligible.sort((a, b) => a!.evidence.cost - b!.evidence.cost || a!.id.localeCompare(b!.id));
    const provider = eligible[0]?.id ?? null;
    if (row.last_ledger_state && row.last_ledger_state.provider === provider) return structuredClone(row);
    return { ...structuredClone(row), last_ledger_state: { provider, at: now.toISOString(), reason: provider ? 'placed' as const : 'unavailable' as const } };
  });
}
export async function readRoutines(): Promise<Routine[]> {
  await privateDirectory(root());
  try { return parseRoutines(await readJson(join(root(), 'routines.json'), 16_384)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function save(rows: Routine[]): Promise<void> {
  const content = safeJson({ schema: 'phantom-routines.v1', routines: rows });
  await privateDirectory(root());
  await writePrivateFileAtomicallyAsync(join(root(), `.${randomUUID()}.tmp`), join(root(), 'routines.json'), content,
    { anchorPath: ashlrHome(), label: 'Routines', beforePublish: () => undefined });
}
/** Merge atomically; conflicting IDs refuse instead of overwriting local work or replaying it. */
export async function importRoutines(value: unknown): Promise<Routine[]> {
  const incoming = parseRoutines(value);
  return withAutomationsLock(async () => {
    const rows = await readRoutines();
    for (const row of incoming) {
      const existing = rows.find(r => r.id === row.id);
      if (existing && safeJson(existing) !== safeJson(row)) throw new Error('Routine ID conflict; existing routines preserved.');
      if (!existing) rows.push(row);
    }
    parseRoutines({ schema: 'phantom-routines.v1', routines: rows });
    await save(rows); return rows;
  });
}
/** Provider IDs are open-ended: codex, claude, devin, grokbot, local, or account slugs. */
export async function rebalanceSavedRoutines(adapters?: RoutineAdapter[], now = new Date()): Promise<Routine[]> {
  return withAutomationsLock(async () => {
    const rows = await readRoutines();
    if (!rows.length) return rows;
    if (!adapters) {
      const value = await readJson(join(root(), 'providers.json'), 16_384);
      if (!record(value) || Object.keys(value).length > 32) invalid();
      adapters = Object.keys(value).map(id => id === 'grokbot' ? grokbotAdapter(async () => value[id]) : routineAdapter(id, async () => value[id]));
    }
    const placed = await rebalanceRoutines(rows, adapters, now);
    if (JSON.stringify(placed) !== JSON.stringify(rows)) await save(placed);
    return placed;
  });
}
