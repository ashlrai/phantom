/**
 * Barrel for the supervised llama-server local serving runtime (`ashlr local-runtime`
 * and the Verse control API).
 *
 * Read docs/LOCAL-FLEET.md first: Ollama cannot serve Qwen3.8 concurrently
 * (`architecture=qwen35` refuses parallel requests), llama-server can, and
 * that measurement is why this module family exists at all.
 *
 * Specialized submodules (`config.ts`, `health.ts`, `anthropic-proxy.ts`,
 * `anthropic-shim.ts`, `process.ts`, `record.ts`, `paths.ts`) are imported
 * directly by their callers; this barrel exposes only the lifecycle and
 * launchd surface consumed by the CLI and Verse control plane.
 */

export type { LlamaRuntimeConfig, LlamaRuntimeSnapshot } from './types.js';

export {
  buildLlamaServerArgs,
  isLoopbackHost,
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

export { launchAgentPlistPath } from './paths.js';

export { anthropicProxyHostInvocation } from './proxy-invocation.js';

export {
  anthropicProxyLogPaths,
  installAnthropicProxyAgent,
  uninstallAnthropicProxyAgent,
} from './proxy-launchd.js';
