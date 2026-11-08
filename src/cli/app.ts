/** Local desktop update inspection and the held app restart. Never downloads, installs, or restarts. */
import {defaultAppUpdateStatusDeps, readAppUpdateStatus, type AppUpdateStatusDependencies} from '../core/app-update-status.js';

export {readAppUpdateStatus, defaultAppUpdateStatusDeps} from '../core/app-update-status.js';
export type {AppUpdateStatus, AppUpdateStatusDependencies} from '../core/app-update-status.js';

/**
 * The current shell reaps Verse and its PTYs on exit. Do not map restart to
 * quit/open until runtime ownership and durable reattachment are implemented.
 */
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
       phm app restart --json

Reports a held restart (exit 1) while the native UI owns live runtime state.
Does not quit, signal processes, replace bundles, or resume authority.
See docs/APP-RESTART.md for the ownership audit and remaining implementation.`;

export async function cmdApp(args: string[], dependencies?: AppUpdateStatusDependencies): Promise<number> {
  if (args.length === 0 || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) {console.log(USAGE); return 0;}
  if (args[0] === 'restart') {
    if (args.length !== 2 || args[1] !== '--json') {console.error(USAGE); return 2;}
    console.log(JSON.stringify(APP_RESTART_HELD));
    return 1;
  }
  if (args[0] !== 'update' || args[1] !== 'status' || args.length > 3 || args.length === 3 && args[2] !== '--json') {console.error(USAGE); return 2;}
  const deps = dependencies ?? defaultAppUpdateStatusDeps();
  const status = readAppUpdateStatus(deps);
  console.log(args.includes('--json') ? JSON.stringify(status) :
    `Current app: ${status.current ?? 'unknown'}\nStaged version: ${status.available ?? 'unknown'}\nDeferred: ${status.deferredReason ?? 'none'}\nBlocking leases: ${status.runningJobCount ?? 'unknown'}\nUnknown leases: ${status.unknownJobs ?? 'unknown'}`);
  return status.deferredReason === 'native-status-unavailable' ? 1 : 0;
}
