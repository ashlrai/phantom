/** Read-only leftover inventory; full argument lists never reach output. */
import { readHostFamilies } from '../core/fleet/host-families.js';

export async function cmdFleetLeftovers(args: string[], read = readHostFamilies): Promise<number> {
  const usage = 'Usage: phm fleet leftovers [--json]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(`${usage}\nList leftover processes from finished fleet jobs. Read-only.`); return 0; }
  if (args.length > 1 || args.some(a => a !== '--json')) { console.error(usage); return 2; }
  const host = await read(), report = { schema: 'fleet.leftovers.v1', ...(host.leftovers ?? { state: 'unknown', items: [] }) };
  if (host.state === 'unknown') report.state = 'unknown';
  console.log(args.includes('--json') ? JSON.stringify(report) : [report.state === 'unknown' ? 'Leftovers: some evidence is unknown' : '',
    ...report.items.map(r => `${r.pid} ${r.job}: ${r.tool}, ${r.cpu}% CPU, age ${r.ageSeconds ?? 'unknown'} seconds`)].filter(Boolean).join('\n') || 'Leftovers: none');
  return report.state === 'known' ? 0 : 1;
}
