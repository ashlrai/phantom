import { readWorkbenchSecrets } from '../core/workbench/secrets.js';
export async function cmdWb(args: string[]): Promise<number> {
  if (args[0] !== 'secrets' || args.slice(1).some(arg => arg !== '--json')) {
    console.error('Usage: phm wb secrets [--json]');
    return 2;
  }
  const reading = await readWorkbenchSecrets();
  if (args.includes('--json')) console.log(JSON.stringify(reading));
  else {
    console.log('Phantom Secrets custody');
    console.log(reading.state === 'unknown' ? 'Custody metadata unavailable.' : `${reading.secrets.length} secrets`);
    for (const row of reading.secrets) console.log(`${row.name}\t${row.scope ?? 'unknown'}\t${row.ageMs === null ? 'unknown' : `${Math.floor(row.ageMs / 86_400_000)} days`}\t${row.lastRotated ?? 'unknown'}`);
  }
  return reading.state === 'ok' ? 0 : 1;
}
