import { parseArgs } from 'node:util';
import { formatQueueBatches, readQueueBatches } from '../core/queue/batches.js';

/** `extra` adds fields to the JSON report; `phm queue --json` uses it for the launch order. */
export async function cmdQueueBatches(args: string[], extra?: () => Promise<Record<string, unknown>>): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      json: { type: 'boolean' }, runs: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { console.log('Usage: phm queue batches [--runs <directory>] [--json]'); return 0; }
    if (positionals.length || values.runs === '') throw new Error('Invalid arguments');
    const report = await readQueueBatches(values.runs);
    console.log(values.json ? JSON.stringify(extra ? { ...report, ...await extra() } : report) : formatQueueBatches(report));
    return 0;
  } catch {
    const error = 'Usage: phm queue batches [--runs <directory>] [--json]';
    if (args.includes('--json')) console.log(JSON.stringify({ error })); else console.error(error);
    return 2;
  }
}
