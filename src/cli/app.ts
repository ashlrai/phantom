/** Local desktop update inspection. Never downloads, installs, or restarts. */
import {defaultAppUpdateStatusDeps, readAppUpdateStatus, type AppUpdateStatusDependencies} from '../core/app-update-status.js';
import {steerLeaders} from '../core/fleet/app-steer.js';

export {readAppUpdateStatus, defaultAppUpdateStatusDeps} from '../core/app-update-status.js';
export type {AppUpdateStatus, AppUpdateStatusDependencies} from '../core/app-update-status.js';

const USAGE = 'usage: phm app update status [--json]\n       phm app steer --text <message> [--json]';
export async function cmdApp(args: string[], dependencies?: AppUpdateStatusDependencies | {runsDir?: string}): Promise<number> {
  if (args[0] === 'steer') {
    if (args.includes('--help') || args.includes('-h')) {console.log(USAGE); return 0;}
    let text: string | undefined;
    let json = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--text' && text === undefined && args[i + 1] !== undefined) text = args[++i];
      else {console.error(USAGE); return 2;}
    }
    if (!text?.trim()) {console.error(USAGE); return 2;}
    const result = await steerLeaders(text, dependencies && 'runsDir' in dependencies ? dependencies : {});
    if (json) console.log(JSON.stringify(result));
    else if (result.ok) console.log(result.status === 'accepted' ? 'Sent to the leaders.' : 'Already sent in the last 10 minutes.');
    else console.error(`error: not sent (${result.reason})`);
    return result.ok ? 0 : 1;
  }
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) {console.log(USAGE); return 0;}
  if (args[0] !== 'update' || args[1] !== 'status' || args.length > 3 || args.length === 3 && args[2] !== '--json') {console.error(USAGE); return 2;}
  const deps = dependencies && !('runsDir' in dependencies) ? dependencies as AppUpdateStatusDependencies : defaultAppUpdateStatusDeps();
  const status = readAppUpdateStatus(deps);
  console.log(args.includes('--json') ? JSON.stringify(status) :
    `Current app: ${status.current ?? 'unknown'}\nStaged version: ${status.available ?? 'unknown'}\nDeferred: ${status.deferredReason ?? 'none'}\nBlocking leases: ${status.runningJobCount ?? 'unknown'}\nUnknown leases: ${status.unknownJobs ?? 'unknown'}`);
  return status.deferredReason === 'native-status-unavailable' ? 1 : 0;
}
