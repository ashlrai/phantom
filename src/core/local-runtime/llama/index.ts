/**
 * The supervised llama-server local serving runtime barrel.
 *
 * Read docs/LOCAL-FLEET.md first: Ollama cannot serve Qwen3.8 concurrently
 * (`architecture=qwen35` refuses parallel requests), llama-server can, and
 * that measurement is why this module family exists at all.
 *
 * Exports the curated lifecycle, config, and launchd surface consumed by
 * `src/cli/local-runtime.ts` and `src/core/verse/control-api.ts`.
 */

export type { LlamaRuntimeConfig, LlamaRuntimeSnapshot } from './types.js';

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

export { resolveOllamaModelBlob } from './ollama-blob.js';

export { errorMessage, launchAgentPlistPath } from './paths.js';

export { anthropicProxyHostInvocation } from './proxy-invocation.js';
export {
  anthropicProxyLogPaths,
  installAnthropicProxyAgent,
  uninstallAnthropicProxyAgent,
} from './proxy-launchd.js';
