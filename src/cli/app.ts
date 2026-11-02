import { isAbsolute } from 'node:path';
import { readAppResources } from '../core/resources/app-resources.js';

export async function cmdApp(args: string[]): Promise<number> {
  const usage = 'Usage: phm app resources [--json] [--queue-dir <absolute directory>]';
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  if (args.shift() !== 'resources') { console.error(usage); return 2; }
  let queueDir: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--queue-dir' && args[i + 1] && isAbsolute(args[i + 1]!)) queueDir = args[++i];
    else { console.error(usage); return 2; }
  }
  const result = await readAppResources(queueDir);
  console.log(json ? JSON.stringify(result) : result.resources.map(row =>
    `${row.pool}: ${row.remainingPercent === null ? 'unknown' : `${row.remainingPercent}% left`} · reset ${row.resetAt ?? 'unknown'} · live jobs ${row.liveJobs ?? 'unknown'}`).join('\n'));
  return 0;
}
