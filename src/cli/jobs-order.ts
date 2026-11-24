import { resolve } from 'node:path';
import { orderReadyFile } from '../core/fleet/ready-yield.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export async function cmdJobsOrder(args: string[]): Promise<number> {
  const usage = 'Usage: phm jobs order [--json] [--apply] [--runs-dir <dir>]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root = runsRoot(), json = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--apply') apply = true;
    else if (args[i] === '--runs-dir' && args[i + 1] && !args[i + 1]!.startsWith('-')) root = resolve(args[++i]!);
    else { console.error(usage); return 2; }
  }
  try {
    const report = await orderReadyFile(root, apply);
    console.log(json ? JSON.stringify(sanitizePublicJson(report)) : [report.line, ...report.rows.map(r => `${r.id}: ${r.reason}`)].join('\n'));
    return 0;
  } catch {
    const error = { schema: 'jobs.order.v1', known: false, applied: false, reason: 'ready queue unavailable, busy or not writable; order unchanged' };
    console.log(json ? JSON.stringify(error) : error.reason); return 1;
  }
}
