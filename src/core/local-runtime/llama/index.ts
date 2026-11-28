/**
 * The supervised llama-server local serving runtime.
 *
 * Read docs/LOCAL-FLEET.md first: Ollama cannot serve Qwen3.8 concurrently
 * (`architecture=qwen35` refuses parallel requests), llama-server can, and
 * that measurement is why this module family exists at all.
 *
 * TWO LANES, and they are not interchangeable:
 *   - OpenAI-compatible completions go straight to llama-server via
 *     {@link resolveLlamaServerBaseUrl}.
 *   - Anthropic (`/v1/messages`) goes through the normalising proxy via
 *     {@link resolveLocalAnthropicBaseUrl}, because Qwen3.8's chat template
 *     rejects Claude Code's request shape outright. See anthropic-shim.ts.
 *
 * Public surface, in the order a caller usually needs it:
 *   - {@link resolveLlamaServerBaseUrl}  which runtime the fleet dispatches to
 *   - {@link resolveLocalAnthropicBaseUrl}  where an Anthropic client points
 *   - {@link startLocalRuntime} / {@link stopLocalRuntime} / {@link restartLocalRuntime}
 *   - {@link statusLocalRuntime} / {@link probeLlamaRuntime}  typed health
 *   - {@link fleetConcurrencyLimit}  the ONLY legitimate source of fleet width
 *   - {@link installLaunchAgent} / {@link uninstallLaunchAgent}  genuine 24/7
 */

export type {
  LlamaRuntimeConfig,
  LlamaRuntimeSnapshot,
} from './types.js';

export {
  buildLlamaServerArgs,
  isLoopbackHost,
  resolveLlamaRuntimeConfig,
  resolveLlamaRuntimeSettings,
  resolveLlamaServerBaseUrl,
  resolveLocalAnthropicBaseUrl,
} from './config.js';
export type { LlamaRuntimeSettings } from './config.js';

export {
  fleetConcurrencyLimit,
  probeLlamaRuntime,
} from './health.js';

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

export {
  resolveOllamaModelBlob,
} from './ollama-blob.js';

export {
  launchAgentPlistPath,
} from './paths.js';

export {
  anthropicProxyHostInvocation,
} from './proxy-invocation.js';
export {
  anthropicProxyLogPaths,
  installAnthropicProxyAgent,
  uninstallAnthropicProxyAgent,
} from './proxy-launchd.js';
