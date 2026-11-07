import { readFile } from 'node:fs/promises';
import { planMergeBatches } from '../core/fleet/merge-batch.js';

const usage = 'Usage: phm fleet merge-batch --input <snapshot.json> [--json]';

export async function cmdFleetMergeBatch(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--input' && !path && args[i + 1] && !args[i + 1]!.startsWith('--')) path = args[++i];
    else { console.error(usage); return 2; }
  }
  if (!path) { console.error(usage); return 2; }
  try {
    const report = planMergeBatches(JSON.parse(await readFile(path, 'utf8')) as unknown);
    console.log(JSON.stringify(report, null, json ? undefined : 2));
    return 0;
  } catch { console.error('error: unable to read or validate merge snapshot'); return 1; }
}
