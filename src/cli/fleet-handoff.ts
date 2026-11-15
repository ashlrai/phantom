import { cmdFleetCoordination } from './fleet-coordination.js';

export async function cmdFleetHandoff(args: string[]): Promise<number> {
  return cmdFleetCoordination(['handoff', ...args]);
}
