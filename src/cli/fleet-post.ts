import { cmdFleetCoordination } from './fleet-coordination.js';

export async function cmdFleetPost(args: string[]): Promise<number> {
  return cmdFleetCoordination(['post', ...args]);
}
