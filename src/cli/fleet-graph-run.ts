import type { Writable } from 'node:stream';
import { graphArgvRun } from '../core/fleet/graph-argv-run.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet graph-run --file <absolute manifest> [--apply] [--concurrency <1..8>] [--timeout-ms <1..3600000>] [--json] [--stream]';
const help = `${usage}\n` +
  'Runs an explicit argv task graph, or previews it with zero effects when --apply is omitted.\n' +
  '--timeout-ms is the whole apply budget, not a per-node timeout: one monotonic deadline is\n' +
  'shared by control reads and every child. After it expires no node launches, active children\n' +
  'are stopped with the usual TERM then KILL escalation and awaited, and nodes that never\n' +
  'started are reported as deadline-exhausted. --concurrency only bounds how many children may\n' +
  'be active at once; it never extends or resets the budget.\n' +
  '--stream emits NDJSON: a version 1 node-terminal event with a node containing only id,\n' +
  'status and exitCode for each terminal node, then one version 1 summary event with result.\n' +
  'Example: {"version":1,"type":"node-terminal","node":{"id":"a","status":"success","exitCode":0}}\n' +
  'Preview emits only a version 1 preview event with result. Child output stays on stderr.';

export async function cmdFleetGraphRun(args: string[], output: Writable = process.stdout): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(help);
    return 0;
  }
  let file = '', apply = false, stream = false, timeout = 900000, concurrency = 1;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--stream') stream = true;
    else if (arg === '--json') continue;
    else if (arg === '--file') file = args[++i] ?? '';
    else if (arg === '--concurrency' && /^[1-8]$/.test(args[i + 1] ?? '')) concurrency = Number(args[++i]);
    else if (arg === '--timeout-ms' && /^\d+$/.test(args[i + 1] ?? '')) timeout = Number(args[++i]);
    else return 2;
  }
  if (stream) {
    let failed = false;
    let rejectWrite: ((error: Error) => void) | undefined;
    const onError = (error: Error): void => { failed = true; rejectWrite?.(error); };
    output.on('error', onError);
    const write = async (event: unknown): Promise<void> => {
      if (failed) throw Error('Output failed');
      await new Promise<void>((resolve, reject) => {
        rejectWrite = reject;
        try {
          output.write(`${JSON.stringify(event)}\n`, error => {
            rejectWrite = undefined;
            if (error) { failed = true; reject(error); } else resolve();
          });
        } catch (error) { failed = true; rejectWrite = undefined; reject(error); }
      });
      if (failed) throw Error('Output failed');
    };
    try {
      const result = await graphArgvRun(file, apply, timeout, concurrency, {
        onNodeTerminal: node => write({ version: 1, type: 'node-terminal', node }),
      });
      await write({ version: 1, type: result.status === 'preview' ? 'preview' : 'summary', result: sanitizePublicJson(result) });
      return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
    } catch { return 1; }
    finally {
      // A failed Writable may emit its error after its write callback. Keep a
      // listener on that unusable stream so the error cannot become unhandled.
      if (!failed) output.removeListener('error', onError);
    }
  }
  const result = await graphArgvRun(file, apply, timeout, concurrency);
  console.log(JSON.stringify(sanitizePublicJson(result)));
  return result.status === 'invalid' ? 2 : ['preview', 'complete'].includes(result.status) ? 0 : 1;
}
