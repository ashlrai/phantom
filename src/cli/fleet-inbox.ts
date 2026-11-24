import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_INBOX_USAGE = 'Usage: ashlr fleet inbox --agent name [--from sender] [--since <when>] [--before <when>] [--contains text] [--json]';

export async function cmdFleetInbox(args: string[]): Promise<number> {
  return cmdFleetCoordination(['inbox', ...args]);
}
