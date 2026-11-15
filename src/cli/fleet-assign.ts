import { cmdFleetCoordination } from './fleet-coordination.js';

export async function cmdFleetAssign(args: string[]): Promise<number> {
  return cmdFleetCoordination(['assign', ...args]);
}
