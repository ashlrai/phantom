import {
  createBoundedReadWorker, createSiblingWorkerEntrypoint, ReadProjectionError,
  validateScopedConsolePath, validateSingleIdPayload, type BoundedReadWorkerOptions,
} from './bounded-read-worker.js';
import { validateUniverseConsoleResponse } from './universe-console-public.js';

export interface UniverseConsoleReader {
  overview(): Promise<string>;
  graph(universeId: string): Promise<string>;
  campaignReadiness(campaignId: string): Promise<string>;
  controllerStatus(controllerId: string): Promise<string>;
  close(): Promise<void>;
}

export function validateUniverseConsoleRoot(value: unknown): string {
  return validateScopedConsolePath(value, 'Universe console requires an explicit absolute non-root path');
}

export function normalizeUniverseConsoleRead(kind: unknown, payload: unknown): undefined | { universeId: string } | { campaignId: string } | { controllerId: string } {
  if (kind === 'overview' && payload === undefined) return undefined;
  const key = kind === 'graph' ? 'universeId'
    : kind === 'campaign-readiness' ? 'campaignId'
      : kind === 'controller-status' ? 'controllerId'
        : null;
  if (key) {
    const valid = validateSingleIdPayload(payload, key);
    if (valid) return valid as { universeId: string } | { campaignId: string } | { controllerId: string };
  }
  throw new ReadProjectionError('Invalid Universe console read', 'READ_PROJECTION_INVALID_REQUEST');
}

const workerEntrypoint = createSiblingWorkerEntrypoint(import.meta.url, 'universe-console-worker');

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
