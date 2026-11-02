import { appConnection, appFetch, appReadings, parseAppRequest } from '../core/web/app-control.js';

export async function cmdApp(args: string[]): Promise<number> {
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
