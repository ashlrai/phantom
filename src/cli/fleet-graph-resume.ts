import { graphResumeRun } from '../core/fleet/graph-resume-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export async function cmdFleetGraphResume(args: string[]): Promise<number> {
  let file = '', checkpoint = '', apply = false, json = false, timeout = 900000, concurrency = 1;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--file') file = args[++i] ?? '';
    else if (arg === '--checkpoint') checkpoint = args[++i] ?? '';
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else if (arg === '--timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) timeout = Number(args[++i]);
    else return 2;
  }
  if (!json) return 2;
  const result = await graphResumeRun(file, checkpoint, apply, timeout, concurrency);
  console.log(JSON.stringify(sanitizePublicJson(result)));
  return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
