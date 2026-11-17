/** Compatibility alias for `phm fleet imessage-tasks`, including its safe receipts and cancellation. */
export const FLEET_TEAMMATE_TASKS_USAGE = 'Usage: phm fleet teammate-tasks enqueue --peer dot|instinct --job <id>';
import { cmdFleetImessageTasks, type FleetImessageTasksDeps } from './fleet-imessage-tasks.js';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { enqueueTeammateTask, listTeammateTasks, runTeammateTasks, teammateTaskPeers } from '../core/comms/imessage-teammate-tasks.js';

export interface FleetTeammateTasksDeps extends FleetImessageTasksDeps {
  enqueue?: typeof enqueueTeammateTask;
  list?: typeof listTeammateTasks;
  dispatch?: typeof runTeammateTasks;
  peers?: typeof teammateTaskPeers;
  config?: typeof loadConfigReadOnlyStrict;
  output?: (text: string) => void;
}

export async function cmdFleetTeammateTasks(args: string[], deps: FleetTeammateTasksDeps = {}): Promise<number> {
  return cmdFleetImessageTasks(args, deps);
}
