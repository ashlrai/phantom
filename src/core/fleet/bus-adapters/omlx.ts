/** Fleet bus boundary; all network I/O and loopback enforcement belong to local-runtime. */
import { OmlxRuntimeClient } from '../../local-runtime/omlx.js';
import type { OmlxCompletionRequest, OmlxRuntimeOptions } from '../../local-runtime/omlx.js';

export type { OmlxCompletion, OmlxCompletionRequest, OmlxMessage, OmlxRuntimeOptions } from '../../local-runtime/omlx.js';
export { OmlxRuntimeError } from '../../local-runtime/omlx.js';

/** Explicit construction only: no automatic discovery, engine registration or fallback. */
export function createOmlxBusAdapter(options: OmlxRuntimeOptions = {}) {
  const runtime = new OmlxRuntimeClient(options);
  return Object.freeze({
    id: 'omlx' as const,
    baseUrl: runtime.baseUrl,
    listModels: (signal?: AbortSignal) => runtime.listModels(signal),
    complete: (request: OmlxCompletionRequest, signal?: AbortSignal) => runtime.complete(request, signal),
  });
}

export type OmlxBusAdapter = ReturnType<typeof createOmlxBusAdapter>;
