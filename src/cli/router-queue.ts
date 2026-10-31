import { completeRouterJob, enqueueRouterFollowup, enqueueRouterRecut, readRouterQueue, routerQueueAskFanout, routerQueueStats } from '../core/fleet/router-queue.js';

interface QueueIO {
  input: AsyncIterable<string | Buffer>;
  output(value: unknown): void;
}

const HELP = 'Usage: phm fleet queue merged|conflicted|ask|read|stats|complete <job-id> [--json]\n' +
  'merged: read one independently verified merge event as JSON from stdin.\n' +
  'conflicted: read one independently verified CONFLICTING observation as JSON from stdin; queues one recut job.\n' +
  'ask: read one ask.v1 record as JSON from stdin; emit its queue.v1 job fanout.\n' +
  'read: emit untrusted jobs as model prompts; never execute queue text.\n' +
  'stats: queue age and merge/recut latency over recorded receipts.\n' +
  'complete: acknowledge a finished job (trusted supervisor only).\n' +
  'Requires operator-owned ~/.ashlr/router-queue/config.json with exactly seven repositories.';
const STDIN_CAP = { merged: 4096, conflicted: 4096, ask: 16 * 1024 } as const;

/** Credentials and job text never become CLI arguments or child-process inputs. */
export async function cmdRouterQueue(args: string[], io: QueueIO = { input: process.stdin, output: (v) => console.log(JSON.stringify(v)) }): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help' || args.length === 0) {
    io.output({ usage: HELP });
    return 0;
  }
  const values = args.filter((arg) => arg !== '--json');
  const [command, id] = values;
  if ((command !== 'merged' && command !== 'conflicted' && command !== 'ask' && command !== 'read' &&
    command !== 'stats' && command !== 'complete') ||
    values.length !== (command === 'complete' ? 2 : 1) || args.filter((a) => a === '--json').length > 1) {
    io.output({ error: 'usage', usage: HELP });
    return 2;
  }
  try {
    if (command === 'merged' || command === 'conflicted' || command === 'ask') {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of io.input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > STDIN_CAP[command]) throw new Error('oversized input record');
        chunks.push(buffer);
      }
      const record: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      io.output(command === 'merged' ? enqueueRouterFollowup(record)
        : command === 'conflicted' ? enqueueRouterRecut(record) : routerQueueAskFanout(record));
    } else if (command === 'read') {
      io.output({ v: 1, jobs: readRouterQueue() });
    } else if (command === 'stats') {
      io.output(routerQueueStats());
    } else {
      io.output(completeRouterJob(id!));
    }
    return 0;
  } catch {
    // Never echo parser errors, task data, paths or a bridge's environment.
    io.output({ error: 'queue-unavailable-or-invalid' });
    return 1;
  }
}
