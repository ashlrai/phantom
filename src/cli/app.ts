/** Desktop status, leader steering and held restart reporting. */
import {defaultAppUpdateStatusDeps, readAppUpdateStatus, type AppUpdateStatusDependencies} from '../core/app-update-status.js';
import {updateDoctor, type UpdateDoctorReport} from '../core/desktop/update-doctor.js';
import {steerLeaders} from '../core/fleet/app-steer.js';

export {readAppUpdateStatus, defaultAppUpdateStatusDeps} from '../core/app-update-status.js';
export type {AppUpdateStatus, AppUpdateStatusDependencies} from '../core/app-update-status.js';

/** Keep restart held until runtime ownership and durable reattachment exist. */
const APP_RESTART_HELD = {
  schema: 'phantom-app-restart/v1',
  state: 'held',
  restarted: false,
  reason: 'runtime-ownership-migration-required',
  blockers: [
    'verse-sidecar-owned-by-ui',
    'interactive-sessions-and-ptys-owned-by-sidecar',
    'computer-use-workers-owned-by-ui',
    'durable-ui-checkpoint-and-reattach-not-implemented',
  ],
} as const;

const USAGE = `usage: phm app update status [--json]
       phm app update-doctor [--json]
       phm app steer --text <message> [--json]
       phm app restart --json

Reports a held restart (exit 1) while the native UI owns live runtime state.
Does not quit, signal processes, replace bundles, or resume authority.
See docs/APP-RESTART.md for the ownership audit and remaining implementation.`;
export async function cmdApp(args: string[], dependencies?: AppUpdateStatusDependencies | {runsDir?: string}, doctor?: () => Promise<UpdateDoctorReport>): Promise<number> {
  if (args[0] === 'restart') {
    if (args.includes('--help') || args.includes('-h')) {console.log(USAGE); return 0;}
    if (args.length !== 2 || args[1] !== '--json') {console.error(USAGE); return 2;}
    console.log(JSON.stringify(APP_RESTART_HELD));
    return 1;
  }
  if (args[0] === 'steer') {
    if (args.includes('--help') || args.includes('-h')) {console.log(USAGE); return 0;}
    let text: string | undefined;
    let json = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--text' && text === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) text = args[++i];
      else {console.error(USAGE); return 2;}
    }
    if (!text?.trim()) {console.error(USAGE); return 2;}
    const result = await steerLeaders(text, dependencies && 'runsDir' in dependencies ? dependencies : {});
    if (json) console.log(JSON.stringify(result));
    else if (result.ok) console.log(result.status === 'accepted' ? 'Sent to the leaders.' : 'Already sent in the last 10 minutes.');
    else console.error(`error: not sent (${result.reason})`);
    return result.ok ? 0 : 1;
  }
  if (args[0] === 'update-doctor') {
    if (args.includes('--help') || args.includes('-h')) {console.log(USAGE); return 0;}
    if (args.length > 2 || args.length === 2 && args[1] !== '--json') {console.error(USAGE); return 2;}
    const report = await (doctor ?? updateDoctor)();
    console.log(args.includes('--json') ? JSON.stringify(report) : `${report.verdict.replaceAll('_', ' ')}: ${report.next_step}`);
    return 0;
  }
  if (args.length === 0 || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) {console.log(USAGE); return 0;}
  if (args[0] !== 'update' || args[1] !== 'status' || args.length > 3 || args.length === 3 && args[2] !== '--json') {console.error(USAGE); return 2;}
  const deps = dependencies && !('runsDir' in dependencies) ? dependencies as AppUpdateStatusDependencies : defaultAppUpdateStatusDeps();
  const status = readAppUpdateStatus(deps);
  console.log(args.includes('--json') ? JSON.stringify(status) :
    `Current app: ${status.current ?? 'unknown'}\nStaged version: ${status.available ?? 'unknown'}\nDeferred: ${status.deferredReason ?? 'none'}\nBlocking leases: ${status.runningJobCount ?? 'unknown'}\nUnknown leases: ${status.unknownJobs ?? 'unknown'}`);
  return status.deferredReason === 'native-status-unavailable' ? 1 : 0;
}
