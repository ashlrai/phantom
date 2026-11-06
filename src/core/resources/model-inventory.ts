/** Opt-in local model measurement. No credentials, environment or user text enter requests. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, rmdir, unlink, statfs } from 'node:fs/promises';

const exec = promisify(execFile);
export type ModelEngine = 'ollama' | 'omlx';
export type ModelTier = 'fast' | 'work' | 'frontier';
export interface ModelInventoryRow {
  id: string; engine: ModelEngine; contextLength: number | null; quantization: string | null;
  residentBytes: number | null; prefillTokensPerSecond: number | null;
  decodeTokensPerSecond: number | null; servableTiers: ModelTier[];
  status: 'measured' | 'unavailable' | 'refused' | 'unsupported';
}
export interface ModelInventoryConfig {
  enabled?: boolean; ollama?: string; omlx?: string;
}
export interface ModelInventory {
  schemaVersion: 1; measuredAt: string; promptTokens: 512; repetitions: 3;
  models: ModelInventoryRow[]; unavailableEngines: ModelEngine[];
}
// Capability thresholds, not a claim about model quality.
export const MODEL_TIER_TABLE: ReadonlyArray<{
  tier: ModelTier; decode: number; prefill: number; context: number; minimumBits: number;
}> = Object.freeze([
  { tier: 'fast', decode: 40, prefill: 100, context: 8192, minimumBits: 4 },
  { tier: 'work', decode: 15, prefill: 50, context: 32768, minimumBits: 4 },
  { tier: 'frontier', decode: 8, prefill: 25, context: 65536, minimumBits: 8 },
]);
function bits(quant: string | null): number {
  if (/^MXFP4$/i.test(quant ?? '')) return 4;
  const match = /(?:^q|^iq|\b)(\d+)(?:[_. -]|bit|$)/i.exec(quant ?? '');
  if (match) return Number(match[1]);
  return /^(?:bf16|fp16|f16)$/i.test(quant ?? '') ? 16 : 0;
}
export function modelTiers(row: ModelInventoryRow): ModelTier[] {
  if (row.status !== 'measured') return [];
  return MODEL_TIER_TABLE.filter(rule => (row.contextLength ?? 0) >= rule.context &&
    bits(row.quantization) >= rule.minimumBits && (row.decodeTokensPerSecond ?? 0) >= rule.decode &&
    (row.prefillTokensPerSecond ?? 0) >= rule.prefill).map(rule => rule.tier);
}
export function inventoryEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid model inventory endpoint'); }
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(value) || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Model inventory requires a numeric loopback HTTP origin');
  }
  return url.origin;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function median(values: number[]): number { return [...values].sort((a, b) => a - b)[1]!; }
export function loopbackListenerNames(output: string): boolean {
  const names = output.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  return names.length > 0 && names.every(name => /^(?:127\.0\.0\.1|\[::1\]):[0-9]+$/.test(name));
}
/** Refuse wildcard/public listeners even when contacted through a loopback address. */
export async function macLoopbackListener(origin: string): Promise<boolean> {
  if (platform() !== 'darwin') return false;
  const port = new URL(origin).port || '80';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], {
        timeout: 5000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin:/usr/sbin' },
      });
      return loopbackListenerNames(stdout);
    } catch { /* A busy host may delay lsof. Every successful read still must prove loopback. */ }
  }
  return false;
}

/** Conservative legacy memguard admission: 35% free, normal pressure, disk headroom.
 * Missing telemetry refuses admission. Rechecked before every inference, including calibration.
 */
export async function macModelAdmission(requiredBytes: number): Promise<boolean> {
  if (platform() !== 'darwin' || !number(requiredBytes)) return false;
  try {
    const options = { timeout: 2000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin:/usr/sbin' } };
    const [memory, pressure, total, disk] = await Promise.all([
      exec('/usr/bin/memory_pressure', [], options),
      exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], options),
      exec('/usr/sbin/sysctl', ['-n', 'hw.memsize'], options), statfs(homedir()),
    ]);
    const free = Number(/System-wide memory free percentage:\s*(\d+)%/.exec(memory.stdout)?.[1]);
    const totalBytes = Number(total.stdout.trim());
    return Number.isFinite(free) && free >= 35 && pressure.stdout.trim() === '1' &&
      totalBytes > 0 && totalBytes * (free / 100 - 0.25) > requiredBytes * 1.2 &&
      disk.bavail * disk.bsize > 10_000_000_000;
  } catch { return false; }
}
export interface InventoryDependencies {
  fetch?: typeof fetch;
  admit?: (requiredBytes: number) => Promise<boolean>;
  verifyListener?: (origin: string) => Promise<boolean>;
}
class EnginesBusyError extends Error {}
let running = false;
export async function measureModelInventory(config: ModelInventoryConfig, deps: InventoryDependencies = {}): Promise<ModelInventory> {
  if (config.enabled !== true) throw new Error('Model inventory is disabled; enable model-inventory.json explicitly');
  const endpoints = {
    ollama: inventoryEndpoint(config.ollama ?? 'http://127.0.0.1:11434'),
    omlx: inventoryEndpoint(config.omlx ?? 'http://127.0.0.1:8000'),
  };
  if (endpoints.ollama === endpoints.omlx) throw new Error('Model engines require distinct origins');
  if (running) throw new Error('Model inventory is already running');
  running = true;
  const request = async (engine: ModelEngine, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    try {
      if (!await (deps.verifyListener ?? macLoopbackListener)(endpoints[engine])) throw new Error();
      const response = await (deps.fetch ?? fetch)(endpoints[engine] + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(180_000), credentials: 'omit',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || response.redirected) throw new Error();
      return object(await response.json());
    } catch { throw new Error('Local model API request refused or failed'); }
  };
  const result: ModelInventory = { schemaVersion: 1, measuredAt: new Date().toISOString(),
    promptTokens: 512, repetitions: 3, models: [], unavailableEngines: [] };
  const catalogs: Partial<Record<ModelEngine, Record<string, unknown>[]>> = {};
  const list = async (engine: ModelEngine): Promise<Record<string, unknown>[]> => {
    const data = await request(engine, engine === 'ollama' ? '/api/tags' : '/admin/api/models');
    if (!Array.isArray(data.models)) throw new Error('Invalid local model catalog');
    return data.models.map(object);
  };
  const idle = async (): Promise<void> => {
    for (const engine of ['ollama', 'omlx'] as const) {
      if (!catalogs[engine]) continue;
      if (engine === 'ollama') {
        const state = await request(engine, '/api/ps');
        if (!Array.isArray(state.models) || state.models.length) throw new EnginesBusyError('Models already resident; inventory refuses to evict other work');
      } else if ((await list(engine)).some(row => row.virtual !== true && (row.loaded || row.is_loading))) {
        throw new EnginesBusyError('Models already resident; inventory refuses to evict other work');
      }
    }
  };
  const confirmIdle = async (): Promise<void> => {
    for (let check = 0; ; check++) {
      try { await idle(); return; }
      catch (error) {
        if (!(error instanceof EnginesBusyError) || check >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  };
  try {
    for (const engine of ['ollama', 'omlx'] as const) {
      try { catalogs[engine] = await list(engine); } catch { result.unavailableEngines.push(engine); }
    }
    await idle();
    for (const engine of ['ollama', 'omlx'] as const) {
      for (const model of catalogs[engine] ?? []) {
        const id = engine === 'ollama' ? model.name : model.id;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id)) continue;
        const row: ModelInventoryRow = { id, engine, contextLength: null, quantization: null,
          residentBytes: null, prefillTokensPerSecond: null, decodeTokensPerSecond: null,
          servableTiers: [], status: 'unsupported' };
        result.models.push(row);
        const detail = engine === 'ollama' ? await request(engine, '/api/show', { model: id }) : model;
        const info = object(detail.model_info);
        row.contextLength = engine === 'ollama' ? number(Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1]) : number(model.model_context_length);
        const quant = engine === 'ollama' ? object(detail.details).quantization_level : model.quantization;
        row.quantization = typeof quant === 'string' && /^(?:[A-Za-z]+)?\d+(?:[A-Za-z0-9_. -]*)$/.test(quant) ? quant : null;
        if (engine === 'omlx' && !row.quantization) row.quantization = /(?:^|[-_])(\d+bit)(?:$|[-_])/i.exec(id)?.[1] ?? null;
        if (engine === 'ollama' && Array.isArray(detail.capabilities) && !detail.capabilities.includes('completion')) continue;
        if (engine === 'omlx' && model.model_type !== 'llm') continue;
        const required = number(engine === 'ollama' ? model.size : model.estimated_size);
        if (!required) continue;
        const rates: { prefill: number; decode: number; memory: number }[] = [];
        let repeats = 512;
        // Every sample is cold. Calibration is bounded and uses only synthetic text.
        for (let attempt = 0; attempt < 6 && rates.length < 3; attempt++) {
          await idle();
          if (!await (deps.admit ?? macModelAdmission)(required)) { row.status = 'refused'; break; }
          let unloadFailed = false;
          const sample = async (): Promise<boolean> => {
            try {
              if (engine === 'ollama') {
                const data = await request(engine, '/api/generate', { model: id, prompt: ' hello'.repeat(repeats),
                  raw: true, stream: false, keep_alive: '5m', options: { num_predict: 64, temperature: 0, num_ctx: 4096, seed: 0 } });
                const count = number(data.prompt_eval_count);
                if (!count) return false;
                if (count !== 512) { if (rates.length) return false; repeats += 512 - count; if (repeats < 1 || repeats > 1024) return false; return true; }
                const state = await request(engine, '/api/ps');
                const resident = Array.isArray(state.models) ? state.models.map(object).find(item => item.name === id || item.model === id) : undefined;
                const memory = number(resident?.size);
                const prefillDuration = number(data.prompt_eval_duration);
                const decodeDuration = number(data.eval_duration);
                const decoded = number(data.eval_count);
                if (!memory || !prefillDuration || !decodeDuration || !decoded || data.done !== true) return false;
                rates.push({ prefill: 512 * 1e9 / prefillDuration, decode: decoded * 1e9 / decodeDuration, memory });
              } else {
                const prompt = ' hello'.repeat(repeats);
                const encoded = await request(engine, '/v1/tokenize', { model: id, prompt });
                const count = number(encoded.count);
                if (!count) return false;
                if (count !== 512) { if (rates.length) return false; repeats += 512 - count; if (repeats < 1 || repeats > 1024) return false; return true; }
                const data = await request(engine, '/v1/completions', { model: id, prompt, max_tokens: 64, temperature: 0, stream: false });
                const usage = object(data.usage);
                const current = (await list(engine)).find(item => item.id === id);
                const memory = number(current?.actual_size);
                const prefill = number(usage.prompt_tokens_per_second);
                const decode = number(usage.generation_tokens_per_second);
                if (usage.prompt_tokens !== 512 || !memory || !prefill || !decode || number(object(usage.prompt_tokens_details).cached_tokens)) return false;
                rates.push({ prefill, decode, memory });
              }
              return true;
            } catch { row.status = 'unavailable'; return false; }
            finally {
              try {
                await request(engine, engine === 'ollama' ? '/api/generate' : `/admin/api/models/${encodeURIComponent(id)}/unload`,
                  engine === 'ollama' ? { model: id, keep_alive: 0, stream: false } : {});
                await confirmIdle();
              } catch { unloadFailed = true; }
            }
          };
          const keepGoing = await sample();
          if (unloadFailed) throw new Error('Model unload could not be confirmed; inventory stopped');
          if (!keepGoing) break;
        }
        if (rates.length === 3) {
          row.status = 'measured'; row.residentBytes = median(rates.map(item => item.memory));
          row.prefillTokensPerSecond = median(rates.map(item => item.prefill));
          row.decodeTokensPerSecond = median(rates.map(item => item.decode)); row.servableTiers = modelTiers(row);
        }
      }
    }
    return result;
  } finally { running = false; }
}

/** Fleet schema: resources.models is the versioned ModelInventory envelope above. */
export async function runModelInventory(home = join(homedir(), '.ashlr'), deps: InventoryDependencies = {}): Promise<ModelInventory> {
  const config = object(JSON.parse(await readFile(join(home, 'model-inventory.json'), 'utf8')));
  if (config.enabled !== true) throw new Error('Model inventory is disabled');
  if (config.ollama !== undefined && typeof config.ollama !== 'string' || config.omlx !== undefined && typeof config.omlx !== 'string') {
    throw new Error('Invalid model inventory configuration');
  }
  const lock = join(home, 'model-inventory.lock');
  await mkdir(lock); // Atomic, cross-process exclusion. Never steal an abandoned lock.
  const file = join(home, 'fleet.json');
  const temp = join(home, `fleet.models.${process.pid}.tmp`);
  try {
    const result = await measureModelInventory(config as ModelInventoryConfig, deps);
    let fleet: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fleet root');
      fleet = object(value);
      if (fleet.resources !== undefined && (fleet.resources === null || typeof fleet.resources !== 'object' || Array.isArray(fleet.resources))) {
        throw new Error('Invalid fleet resources');
      }
    }
    catch (error) { if (object(error).code !== 'ENOENT') throw new Error('Cannot read fleet inventory'); }
    fleet.resources = { ...object(fleet.resources), models: result };
    await writeFile(temp, JSON.stringify(fleet, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
    return result;
  } finally { await unlink(temp).catch(() => {}); await rmdir(lock); }
}
