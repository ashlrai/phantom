/** Local desktop update inspection and console app control. Never downloads, installs, or restarts. */
import {defaultAppUpdateStatusDeps, readAppUpdateStatus, type AppUpdateStatusDependencies} from '../core/app-update-status.js';
import {appConnection, appFetch, appReadings, parseAppRequest} from '../core/web/app-control.js';

export {readAppUpdateStatus, defaultAppUpdateStatusDeps} from '../core/app-update-status.js';
export type {AppUpdateStatus, AppUpdateStatusDependencies} from '../core/app-update-status.js';

const USAGE = 'usage: phm app update status [--json]\n       phm app <status|resources|budgets|state> --json\n       phm app steer <pause|resume> --json\n       phm app prefs [<update-json>] --json';
const CONTROL_COMMANDS = new Set(['status', 'resources', 'budgets', 'state', 'steer', 'prefs']);
async function cmdAppControl(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  try {
    const [command, ...rest] = args;
    if (!rest.includes('--json')) throw new Error('Use phm app <status|resources|budgets|state|steer|prefs> --json');
    const file = process.env['PHM_APP_CONNECTION_FILE'];
    if (!file) throw new Error('Set PHM_APP_CONNECTION_FILE to the private console connection file');
    const positional = rest.filter(a => a !== '--json');
    const connection = await appConnection(file);
    let result: unknown;
    if (command === 'steer' || (command === 'prefs' && positional.length)) {
      const request = parseAppRequest({ version: 'app.control.v1', action: command === 'prefs' ? 'prefs' : positional[0],
        ...(command === 'prefs' ? { update: JSON.parse(positional[0] ?? '') } : {}) });
      if (command === 'steer' && positional.length !== 1) throw new Error('Use steer pause or steer resume');
      result = await appFetch(connection, '/api/app/v1/control', request);
    } else {
      if (positional.length) throw new Error('Unexpected app arguments');
      const routes: Record<string, string> = { status: '/api/fleet', state: '/api/fleet', resources: '/api/resource', budgets: '/api/control', prefs: '/api/verse/preferences' };
      const route = routes[command ?? ''];
      if (!route) throw new Error('Unknown app command');
      result = await appFetch(connection, route);
    }
    console.log(JSON.stringify({ version: 'app.control.v1', result: appReadings(result) }));
    return 0;
  } catch { console.error(JSON.stringify({ error: 'App request refused. Check command, connection file and console authority.' })); return 1; }
}
export async function cmdApp(args: string[], dependencies?: AppUpdateStatusDependencies): Promise<number> {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) {console.log(USAGE); return 0;}
  const first = args[0];
  if (first !== 'update') {
    if (first === undefined || !CONTROL_COMMANDS.has(first)) {console.error(USAGE); return 2;}
    return cmdAppControl(args);
  }
  if (args[1] !== 'status' || args.length > 3 || args.length === 3 && args[2] !== '--json') {console.error(USAGE); return 2;}
  const deps = dependencies ?? defaultAppUpdateStatusDeps();
  const status = readAppUpdateStatus(deps);
  console.log(args.includes('--json') ? JSON.stringify(status) :
    `Current app: ${status.current ?? 'unknown'}\nStaged version: ${status.available ?? 'unknown'}\nDeferred: ${status.deferredReason ?? 'none'}\nBlocking leases: ${status.runningJobCount ?? 'unknown'}\nUnknown leases: ${status.unknownJobs ?? 'unknown'}`);
  return status.deferredReason === 'native-status-unavailable' ? 1 : 0;
}
