import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_INBOX_USAGE = 'Usage: ashlr fleet inbox --agent name [--json]';

export async function cmdFleetInbox(args: string[]): Promise<number> {
  return cmdFleetCoordination(['inbox', ...args]);
}
