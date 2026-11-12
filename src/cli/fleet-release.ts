import { cmdFleetCoordination } from './fleet-coordination.js';

export async function cmdFleetRelease(args: string[]): Promise<number> {
  return cmdFleetCoordination(['release', ...args]);
}
