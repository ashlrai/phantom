/** Read-only MCP adapter for staging-directory inventory (no cleanup). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inventoryStaging, type InventoryDeps, type InventoryDeps as InventoryDepsType } from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FleetStagingInventoryArgs {}

export function parseFleetStagingInventoryArgs(_input: Record<string, unknown>): FleetStagingInventoryArgs | null {
  if (typeof _input !== 'object' || _input === null || Array.isArray(_input)) return null;
  const keys = Object.keys(_input);
  if (keys.length !== 0) return null;
  return {};
}

export function readFleetStagingInventory(_args: FleetStagingInventoryArgs, deps: InventoryDepsType = {}): ReturnType<typeof inventoryStaging> {
  const root = join(homedir(), '.local/share/ashlr/release-staging');
  return inventoryStaging(root, deps);
}
