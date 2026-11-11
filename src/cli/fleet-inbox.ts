import { cmdFleetCoordination } from './fleet-coordination.js';

export async function cmdFleetInbox(args: string[]): Promise<number> {
  return cmdFleetCoordination(['inbox', ...args]);
}
