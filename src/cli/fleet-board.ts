import { cmdFleetCoordination } from './fleet-coordination.js';

export async function cmdFleetBoard(args: string[]): Promise<number> {
  return cmdFleetCoordination(['board', ...args]);
}
