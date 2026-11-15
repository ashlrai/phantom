/**
 * core/connect/discovery.ts: find signed-in CLIs and services on this machine.
 *
 * Discovery is deliberately shallow:
 *   - Each vendor row comes from its status command only (argv, bounded
 *     timeout, output captured). Token and session file CONTENTS are never
 *     read to decide sign-in state.
 *   - The `mcp` row comes from the MCP registry scan of client config files
 *     (server names + commands; env values are never surfaced).
 *   - Never throws: a missing CLI or a failing probe yields
 *     reason 'signed-out' or 'probe-unavailable'.
 */

import { CONNECT_SERVICES, getConnectService } from './services.js';
import { scrubSecrets } from '../util/scrub.js';
import type {
  ConnectDeps,
  ConnectDiscoveryRow,
  ConnectServiceId,
} from './types.js';

export function discoverConnectAccounts(deps: ConnectDeps): ConnectDiscoveryRow[] {
  const rows: ConnectDiscoveryRow[] = [];
  for (const service of CONNECT_SERVICES) {
    rows.push(discoverOne(service.id, deps));
  }
  return rows;
}

export function discoverOne(serviceId: ConnectServiceId, deps: ConnectDeps): ConnectDiscoveryRow {
  const service = getConnectService(serviceId);
  if (!service) {
    return {
      service: serviceId, label: serviceId, signedIn: false, account: null,
      reason: 'probe-unavailable', scopes: [], notes: [],
    };
  }
  const notes: string[] = [];
  if (service.sessionCopyProhibitedReason) {
    notes.push(service.sessionCopyProhibitedReason);
  }

  // The MCP pseudo-service: configured servers from client config files.
  if (service.probe === null) {
    let servers: readonly { name: string; command: string }[] = [];
    try {
      servers = deps.mcpServers();
    } catch {
      servers = [];
    }
    if (servers.length > 0) {
      notes.push(`configured: ${servers.map((s) => s.name).join(', ')}`);
    }
    return {
      service: service.id,
      label: service.label,
      signedIn: servers.length > 0,
      account: servers.length > 0 ? `${servers.length} server${servers.length === 1 ? '' : 's'}` : null,
      reason: 'registry',
      scopes: [...service.scopes],
      notes,
    };
  }

  const result = deps.run(service.probe.argv, { timeoutMs: service.probe.timeoutMs });
  if (result.error !== undefined || result.status === null) {
    return {
      service: service.id,
      label: service.label,
      signedIn: false,
      account: null,
      reason: 'probe-unavailable',
      scopes: [...service.scopes],
      notes,
    };
  }
  const signedIn = service.probe.signedIn(result);
  const account = signedIn ? service.probe.account(result) : null;
  return {
    service: service.id,
    label: service.label,
    signedIn,
    // The account label comes from vendor stdout; scrub so a token-shaped
    // string in status output can never be persisted or re-printed.
    account: account === null ? null : scrubSecrets(account).slice(0, 256),
    reason: signedIn ? 'signed-in' : 'signed-out',
    scopes: [...service.scopes],
    notes,
  };
}
