import { readFile, stat } from 'node:fs/promises';
import { formatQueueLatency, queueLatency, validQueueLatencyInput } from '../core/fleet/queue-latency.js';

export { queueLatency, formatQueueLatency, validQueueLatencyInput };
export type { QueueLatencyInput, QueueLatencyPr, QueueLatencyReport, QueueLatencyAdvice, QueueStage } from '../core/fleet/queue-latency.js';

const MAX_BYTES = 8 * 1024 * 1024;
const usage = 'Usage: phm fleet queue-latency --input <snapshot.json> [--json]\nShow where PRs lose time on the way to merge (approval, joining the queue, waiting in it, running checks) and which conflicts can be recut automatically. Snapshot: {prs:[{repo,number,stages:[{stage,at}],headSha?,mergeable?,queuePosition?,recutRequests?,lastRecutHead?}]}. Stages: opened, approved, queued, checks_started. Read-only: required checks always stay in place and nothing is merged or requeued.';

export async function cmdFleetQueueLatency(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--input' && !path && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i];
    else { console.error(usage); return 2; }
  }
  if (!path) { console.error(usage); return 2; }
  try {
    if ((await stat(path)).size > MAX_BYTES) throw new Error('Snapshot too large');
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validQueueLatencyInput(input)) throw new Error('Invalid snapshot');
    const report = queueLatency(input);
    console.log(json ? JSON.stringify(report) : formatQueueLatency(report));
    return 0;
  } catch { console.error('error: unable to read a valid queue snapshot; use --help for its shape'); return 1; }
}
