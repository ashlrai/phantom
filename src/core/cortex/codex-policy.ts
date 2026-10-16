export { assertNoCortexProjectConfig } from './config.js';
import { BUILTIN_ENGINE_REGISTRY } from '../run/engine-registry.js';
import { autonomousConfinementProfile } from '../sandbox/confine.js';
import type { AshlrConfig } from '../types.js';

/** Native model transport stays available; model-authored shell commands have no network. */
export const CORTEX_CODEX_PERMISSION_PROFILE = 'cortex-proposal';
export const CORTEX_CODEX_PERMISSION_CONFIG = 'permissions.cortex-proposal={filesystem={":minimal"="read",":workspace_roots"={"."="write"}},network={enabled=false}}';
export const CORTEX_CODEX_RESTRICTED_ARGS = Object.freeze([
  '--ignore-user-config', '--ignore-rules', '--ephemeral',
  '-c', 'default_permissions="cortex-proposal"', '-c', CORTEX_CODEX_PERMISSION_CONFIG,
  '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
  '-c', 'project_root_markers=[".git"]',
  ...['apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
    'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'image_generation', 'realtime_conversation']
    .flatMap(feature => ['--disable', feature]),
]);

export function cortexCodexConfig(config: AshlrConfig): AshlrConfig {
  return { ...config, notify: undefined, foundry: { ...config.foundry,
    autoMerge: { ...config.foundry?.autoMerge, enabled: false, allowWithoutVerification: false },
    confinement: { ...config.foundry?.confinement, codex: { ...autonomousConfinementProfile('codex'), denyCodexProjectConfig: true } },
    engines: { ...config.foundry?.engines, codex: { ...BUILTIN_ENGINE_REGISTRY.codex!,
      argv: [...BUILTIN_ENGINE_REGISTRY.codex!.argv!], autonomousArgv: [...CORTEX_CODEX_RESTRICTED_ARGS] } },
  } };
}
