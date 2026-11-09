import { fleetStatusApi } from '../core/fleet/status-api.js';

const usage = 'Usage: phm fleet status-api --json';
export async function cmdFleetStatusApi(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length !== 1 || args[0] !== '--json') { console.error(usage); return 2; }
  try { console.log(JSON.stringify(await fleetStatusApi())); return 0; }
  catch { console.error('error: fleet status unavailable'); return 1; }
}
