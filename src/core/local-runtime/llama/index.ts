/**
 * Supervision barrel for the local llama-server serving runtime.
 *
 * Consumed by `src/cli/local-runtime.ts` and the Verse control API
 * (`src/core/verse/control-api.ts`). Lower-level modules (`config.ts`,
 * `health.ts`, `process.ts`, `anthropic-proxy.ts`, etc.) are imported
 * directly by their callers.
 */

export type {
  LlamaRuntimeConfig,
  LlamaRuntimeSnapshot,
} from './types.js';

export {
  buildLlamaServerArgs,
  isLoopbackHost,
  originFor,
  resolveLlamaRuntimeConfig,
} from './config.js';

export {
  restartLocalRuntime,
  startLocalRuntime,
  statusLocalRuntime,
  stopLocalRuntime,
} from './supervisor.js';
export type { LifecycleOptions } from './supervisor.js';

export {
  installLaunchAgent,
  launchAgentLoaded,
  launchAgentLogPaths,
  uninstallLaunchAgent,
} from './launchd.js';
export type { LaunchAgentMutation } from './launchd.js';

export { resolveOllamaModelBlob } from './ollama-blob.js';

export {
  formatErrorMessage,
  isRegularFile,
  launchAgentPlistPath,
} from './paths.js';

export { anthropicProxyHostInvocation } from './proxy-invocation.js';

export {
  anthropicProxyLogPaths,
  installAnthropicProxyAgent,
  uninstallAnthropicProxyAgent,
} from './proxy-launchd.js';
