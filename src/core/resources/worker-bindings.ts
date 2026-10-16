/** Pure operator binding schema; no transport, process, account or default-config imports. */
import { isAbsolute } from 'node:path';
import { normalizeNumericLoopbackOllamaBaseUrl } from '../run/ollama-identity.js';
import { validateResourcePool, type ResourcePool, type ResourceWorker } from './pool-policy.js';

export type ResourceBinding =
  | { workerId: string; capacityKey: string; kind: 'native-cli'; command: string[] }
  | { workerId: string; capacityKey: string; kind: 'local-chat'; endpoint: string };
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function array(value: unknown, min: number, max: number): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, i) => i)
      .every((i) => Object.hasOwn(value, i) && 'value' in Object.getOwnPropertyDescriptor(value, i)!);
}
function identifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER.test(value); }
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
    Buffer.byteLength(value, 'utf8') <= limit;
}
/**
 * Bindings are trusted operator configuration, not model input. Prefix argv may
 * select an owner-authenticated wrapper; the adapter does not discover accounts,
 * accept credentials/environment overrides, or prove a wrapper's behavior.
 */
export function validateResourceBindings(value: unknown, pool: ResourcePool): ResourceBinding[] {
  const definition = validateResourcePool(pool);
  if (!array(value, 1, definition.workers.length) || value.length !== definition.workers.length) throw new Error('Invalid resource bindings');
  const workers = new Map(definition.workers.map((worker) => [worker.id, worker]));
  const seen = new Set<string>(); const capacities = new Map<string, ResourceWorker>();
  const result: ResourceBinding[] = [];
  for (const row of value) {
    const kind = object(row) ? Object.getOwnPropertyDescriptor(row, 'kind')?.value : undefined;
    if (!object(row) || !exact(row, kind === 'native-cli'
      ? ['workerId', 'capacityKey', 'kind', 'command'] : ['workerId', 'capacityKey', 'kind', 'endpoint']) ||
        !identifier(row.workerId) || !identifier(row.capacityKey) || seen.has(row.workerId)) {
      throw new Error('Invalid resource bindings');
    }
    const worker = workers.get(row.workerId); const shared = capacities.get(row.capacityKey);
    if (!worker || (shared && (shared.provider !== worker.provider || shared.maxConcurrent !== worker.maxConcurrent ||
        shared.maxTasksPerWindow !== worker.maxTasksPerWindow || shared.taskWindowMs !== worker.taskWindowMs))) {
      throw new Error('Invalid resource bindings: shared capacity requires consistent provider and task bounds');
    }
    let binding: ResourceBinding;
    if (row.kind === 'native-cli' && worker.provider !== 'local' && array(row.command, 1, 32) &&
        row.command.every((arg) => text(arg, 4_096)) && isAbsolute(row.command[0] as string) &&
        row.command.reduce((bytes, arg) => bytes + Buffer.byteLength(arg as string, 'utf8'), 0) <= 16 * 1024) {
      const command = [...row.command] as string[]; Object.freeze(command);
      binding = { workerId: row.workerId, capacityKey: row.capacityKey, kind: 'native-cli', command };
    } else if (row.kind === 'local-chat' && worker.provider === 'local' && text(row.endpoint, 512)) {
      const endpoint = normalizeNumericLoopbackOllamaBaseUrl(row.endpoint);
      if (!endpoint) throw new Error('Invalid resource bindings: numeric loopback endpoint required');
      binding = { workerId: row.workerId, capacityKey: row.capacityKey, kind: 'local-chat', endpoint };
    } else throw new Error('Invalid resource bindings');
    seen.add(worker.id); capacities.set(row.capacityKey, worker); result.push(Object.freeze(binding));
  }
  return Object.freeze(result) as ResourceBinding[];
}
