import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_RELEASE_USAGE = 'Usage: ashlr fleet release <claim-id> --agent name --lease <lease> [--json]';

export async function cmdFleetRelease(args: string[]): Promise<number> {
  return cmdFleetCoordination(['release', ...args]);
}
