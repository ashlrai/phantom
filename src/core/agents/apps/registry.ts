import { createRegistry, type AgentAppRegistry } from './adapter.js';
import { createCliAgentApps, type CliAdapterDeps } from './cli-adapters.js';
import { createDesktopAgentApps } from './desktop-adapters.js';
import type { DesktopSessionsDeps } from '../../desktop/desktop-sessions.js';

export interface AgentAppRegistryDeps { cli?: CliAdapterDeps; desktop?: DesktopSessionsDeps }

/** CLI adapters first; `<provider>-desktop` is the UI-driven fallback for each app. */
export function createAgentAppRegistry(deps: AgentAppRegistryDeps = {}): AgentAppRegistry {
  return createRegistry([...createCliAgentApps(deps.cli), ...createDesktopAgentApps(deps.desktop)]);
}
