import { readFile, stat } from 'node:fs/promises';

import { sizeWorkerSession } from '../core/org/session-economics.js';

const MAX_SNAPSHOT_BYTES = 64 * 1024;
const USAGE = `Usage: phm fleet session-economics --input <snapshot.json> [--json]
Advisory only: compares measured warm and fresh worker sessions from an explicit snapshot.
Reads that one file (max 64 KiB). No home scans, provider calls, writes or launches.
The snapshot needs queued, liveClaims, tokenCeiling, fanOutCeiling, warm (or null), fresh[].
Ceilings are caller inputs only; nothing is inferred. Output grants no execution authority.`;

/** Read-only advisory verb. Errors are fixed strings; raw file content and paths are never echoed. */
export async function cmdFleetSessionEconomics(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let input: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--input' && input === null && args[i + 1] && !args[i + 1]!.startsWith('--')) input = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  if (input === null) { console.error(USAGE); return 2; }
  let result;
  try {
    const info = await stat(input);
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) { console.error('error: snapshot must be a file of at most 64 KiB'); return 1; }
    result = sizeWorkerSession(JSON.parse(await readFile(input, 'utf8')));
  } catch {
    console.error('error: unable to read a valid session snapshot');
    return 1;
  }
  const report = { schema: 'fleet.session-economics.v1', advisory: true, executionAuthority: 'none', ...result };
  console.log(json ? JSON.stringify(report) : `session-economics (advisory, no execution authority): action=${report.action}${report.sizing ? ` plannedTasks=${report.sizing.plannedTasks} tokensPerTask=${report.sizing.tokensPerTask}` : ''}`);
  return 0;
}
