import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_HANDOFF_USAGE = 'Usage: ashlr fleet handoff <claim-id> --agent name --lease <lease> --to name [--ttl-seconds 3600] [--json]';

export async function cmdFleetHandoff(args: string[]): Promise<number> {
  return cmdFleetCoordination(['handoff', ...args]);
}
