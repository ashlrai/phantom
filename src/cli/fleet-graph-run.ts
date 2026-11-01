import { graphArgvRun } from '../core/fleet/graph-argv-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export async function cmdFleetGraphRun(args: string[]): Promise<number> {
  let file = '', apply = false, timeout = 900000;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') continue;
    else if (arg === '--file') file = args[++i] ?? '';
    else if (arg === '--timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) timeout = Number(args[++i]);
    else return 2;
  }
  const result = await graphArgvRun(file, apply, timeout);
  console.log(JSON.stringify(sanitizePublicJson(result)));
  return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
