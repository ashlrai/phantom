/** Read-only MCP adapter for staging-directory inventory (observation only). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inventoryStaging, type InventoryDeps } from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export type FleetStagingInventoryArgs = Record<string, never>;

export function parseFleetStagingInventoryArgs(input: Record<string, unknown>): FleetStagingInventoryArgs | null {
  if (Array.isArray(input) || Object.keys(input).length !== 0) return null;
  return {};
}

/** Fixed root, same as `ashlr fleet staging-inventory` — no caller-chosen path. */
export async function readFleetStagingInventory(_args: FleetStagingInventoryArgs, deps: InventoryDeps = {}): Promise<unknown> {
  const root = join(homedir(), '.local/share/ashlr/release-staging');
  return sanitizePublicJson(await inventoryStaging(root, deps));
}
