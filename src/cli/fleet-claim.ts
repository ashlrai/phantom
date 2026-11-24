import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_CLAIM_USAGE = 'Usage: ashlr fleet claim --repo owner/repo --task "work" --agent name [--ttl-seconds 3600] [--json]';

export async function cmdFleetClaim(args: string[]): Promise<number> {
  return cmdFleetCoordination(['claim', ...args]);
}
