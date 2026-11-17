import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_ASSIGN_USAGE = 'Usage: ashlr fleet assign --repo owner/repo --task "work" --to name [--ttl-seconds 3600] [--json]';

export async function cmdFleetAssign(args: string[]): Promise<number> {
  return cmdFleetCoordination(['assign', ...args]);
}
