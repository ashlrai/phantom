import { isAbsolute, parse, resolve } from 'node:path';
import { containsControlChars } from '../universe/input-guards.js';
import { isWebRecord } from './api-http-helpers.js';
import { createBoundedReadWorker, ReadProjectionError, resolveBoundedWorkerEntrypoint, type BoundedReadWorkerOptions } from './bounded-read-worker.js';
import { validateUniverseConsoleResponse } from './universe-console-public.js';

export interface UniverseConsoleReader {
  overview(): Promise<string>;
  graph(universeId: string): Promise<string>;
  campaignReadiness(campaignId: string): Promise<string>;
  controllerStatus(controllerId: string): Promise<string>;
  close(): Promise<void>;
}

const SLUG_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function singleSlugField(payload: unknown, field: string): string | null {
  if (!isWebRecord(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, field)) return null;
  const value = payload[field];
  return typeof value === 'string' && SLUG_ID.test(value) ? value : null;
}

export function validateUniverseConsoleRoot(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 ||
    containsControlChars(value) || resolve(value) === parse(value).root) {
    throw new Error('Universe console requires an explicit absolute non-root path');
  }
  return resolve(value);
}

export function normalizeUniverseConsoleRead(kind: unknown, payload: unknown): undefined | { universeId: string } | { campaignId: string } | { controllerId: string } {
  if (kind === 'overview' && payload === undefined) return undefined;
  if (kind === 'graph') {
    const universeId = singleSlugField(payload, 'universeId');
    if (universeId) return { universeId };
  }
  if (kind === 'campaign-readiness') {
    const campaignId = singleSlugField(payload, 'campaignId');
    if (campaignId) return { campaignId };
  }
  if (kind === 'controller-status') {
    const controllerId = singleSlugField(payload, 'controllerId');
    if (controllerId) return { controllerId };
  }
  throw new ReadProjectionError('Invalid Universe console read', 'READ_PROJECTION_INVALID_REQUEST');
}

function workerEntrypoint(): URL {
  return resolveBoundedWorkerEntrypoint(import.meta.url, 'universe-console-reads.ts', 'universe-console-worker');
}

/** Root is pinned in workerData, never taken from a browser request or default configuration. */
export function createUniverseConsoleReader(root: string, options: Pick<BoundedReadWorkerOptions,
  'maxPending' | 'timeoutMs' | '_workerFactory'> = {}): UniverseConsoleReader {
  const transport = createBoundedReadWorker({ ...options, workerEntrypoint,
    workerData: { root: validateUniverseConsoleRoot(root) }, normalize: normalizeUniverseConsoleRead,
    timeoutMs: options.timeoutMs ?? 30_000 });
  return { overview: () => transport.read('overview').then(validateUniverseConsoleResponse),
    graph: (universeId) => transport.read('graph', { universeId }).then(validateUniverseConsoleResponse),
    campaignReadiness: (campaignId) => transport.read('campaign-readiness', { campaignId }).then(validateUniverseConsoleResponse),
    controllerStatus: (controllerId) => transport.read('controller-status', { controllerId }).then(validateUniverseConsoleResponse),
    close: () => transport.close() };
}
