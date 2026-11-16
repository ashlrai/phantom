import { cmdFleetCoordination } from './fleet-coordination.js';

export async function cmdFleetClaim(args: string[]): Promise<number> {
  return cmdFleetCoordination(['claim', ...args]);
}
