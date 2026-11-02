import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';

export interface Connector { name: string; enabled: boolean }
export interface ConnectorSnapshot { revision: string; connectors: Connector[] }
const PATH = '/api/verse/mcp/connectors';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Allowlist before caching: never retain arbitrary configuration or response errors. */
export function projectConnectors(raw: unknown): ConnectorSnapshot {
  if (!record(raw) || typeof raw.revision !== 'string' || !/^[a-f0-9]{40}$/.test(raw.revision) || !Array.isArray(raw.connectors)) throw new Error('Connector response unavailable.');
  const names = new Set<string>();
  const connectors = raw.connectors.map((row: unknown): Connector => {
    if (!record(row) || typeof row.name !== 'string' || !row.name || row.name.length > 160 || typeof row.enabled !== 'boolean' || names.has(row.name)) throw new Error('Connector response unavailable.');
    names.add(row.name);
    return { name: row.name, enabled: row.enabled };
  });
  return { revision: raw.revision, connectors };
}

export const connectorsQuery = {
  key: 'settings-connectors',
  fetch: async (signal?: AbortSignal) => {
    try { return projectConnectors(await apiGet<unknown>(PATH, signal)); }
    catch { throw new Error('Connectors could not be loaded.'); }
  },
};

export async function changeConnector(connector: Connector, revision: string): Promise<void> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions in Connection before changing connectors.');
  try {
    await apiPost<unknown>(PATH, { name: connector.name, enabled: !connector.enabled, revision, confirm: true }, token);
    touchMutationHold();
    invalidate(connectorsQuery.key);
    invalidate('verse-mcp-snapshot');
  } catch { throw new Error('Connector change refused. Refresh and try again.'); }
}
