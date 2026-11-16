import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_BOARD_USAGE = 'Usage: ashlr fleet board [--json]';

export async function cmdFleetBoard(args: string[]): Promise<number> {
  return cmdFleetCoordination(['board', ...args]);
}
