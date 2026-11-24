import { cmdFleetCoordination } from './fleet-coordination.js';

export const FLEET_POST_USAGE = 'Usage: ashlr fleet post --from name --to name --message "text" [--ttl-seconds 3600] [--json]';

export async function cmdFleetPost(args: string[]): Promise<number> {
  return cmdFleetCoordination(['post', ...args]);
}
