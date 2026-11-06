import { ConnectorError, readProfile, validateProfile } from './profile.js';

export interface ConnectorRunSelectors { scope: string; tool: string; lane: string; }

/** Main-line stub. Credential resolution and execution require a separate Security review. */
export async function runConnector(
  id: string,
  selectors: ConnectorRunSelectors,
  args: string[],
  home?: string,
): Promise<never> {
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(id)) throw new ConnectorError('Invalid connector id.');
  const connector = (await readProfile(home)).connectors.find(c => c.id === id);
  if (!connector) throw new ConnectorError('Connector not found. Run phm connectors list.');
  if (connector.kind !== 'cli') throw new ConnectorError('Only CLI connectors support run. MCP and plugin entries remain metadata only.');
  // Reuse the metadata boundary, including credential-argument and secret-shape refusal.
  validateProfile({ version: 1, connectors: [{ ...connector, args: [...connector.args, ...args] }] });
  if (!selectors.scope || !selectors.tool || !selectors.lane
    || !connector.scopes.includes(selectors.scope)
    || !connector.tools.includes(selectors.tool)
    || !connector.lanes.includes(selectors.lane)) {
    throw new ConnectorError('Connector selectors denied. Supply an explicitly listed scope, tool and lane.');
  }
  // Caller selectors are requests, never a Locus grant. No environment switch bypasses this stub.
  throw new ConnectorError('Connector execution denied pending Security review of Locus authorization and Phantom Secrets binding injection. No process started.');
}
