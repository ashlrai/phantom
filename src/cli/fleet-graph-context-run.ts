import { graphContextRun } from '../core/fleet/graph-context-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';

const usage = 'Usage: ashlr fleet graph-context-run --file <absolute manifest.json> [--apply] [--concurrency <1..8>] [--json]';
export async function cmdFleetGraphContextRun(args: string[], io: ContextWorkerIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nLaunch manifest tasks through the context worker, independent nodes in parallel up to the bound; cited context is untrusted data.\n`);
    return 0;
  }
  let file = '', apply = false, concurrency = 1;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') continue;
    else if (arg === '--file') file = args[++i] ?? '';
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else return 2;
  }
  const result = await graphContextRun(file, apply, io, concurrency);
  (io.stdout ?? process.stdout).write(`${JSON.stringify(sanitizePublicJson(result))}\n`);
  return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
