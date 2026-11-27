/**
 * Entry barrel for the supervised llama-server local serving runtime.
 *
 * Read docs/LOCAL-FLEET.md first: Ollama cannot serve Qwen3.8 concurrently
 * (`architecture=qwen35` refuses parallel requests), llama-server can, and
 * that measurement is why this module family exists at all.
 *
 * Surface exported here for CLI and control-API callers:
 *   - {@link startLocalRuntime} / {@link stopLocalRuntime} / {@link restartLocalRuntime} / {@link statusLocalRuntime}
 *   - {@link installLaunchAgent} / {@link uninstallLaunchAgent} / {@link installAnthropicProxyAgent} / {@link uninstallAnthropicProxyAgent}
 *   - {@link resolveLlamaRuntimeConfig} / {@link buildLlamaServerArgs} / {@link resolveOllamaModelBlob}
 */

export type { LlamaRuntimeConfig, LlamaRuntimeSnapshot } from './types.js';

export { buildLlamaServerArgs, isLoopbackHost, resolveLlamaRuntimeConfig } from './config.js';

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
