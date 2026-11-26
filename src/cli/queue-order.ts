/** `phm queue`, `phm queue top|lane|drop`: thin handler. The reader and the writes live in core/queue/order.ts. */
import { QUEUE_ORDER_ACTIONS, type QueueActionRequest, type QueueOrderAction } from '../core/queue/order-types.js';
import { QueueSteerError, queueOrderText, readQueueOrder, steerQueue } from '../core/queue/order.js';

const QUEUE_ORDER_HELP = `Usage: phm queue [--json]
       phm queue top <id> [--dry-run] [--json]
       phm queue lane <id> <lane> [--dry-run] [--json]
       phm queue drop <id> [--dry-run] [--json]
List the queued jobs in the order they launch, or steer one of them.
  top    move the job to the front of the queue
  lane   move the job to another lane
  drop   take the job out; its row is kept in queue/dropped.tsv
Each action edits queue/ready.tsv under queue/ready.lock, keeps the earlier text in queue/ready.tsv.bak
and prints what changed. --dry-run prints the change and writes nothing.
  --json  the list is the launch field of phm queue --json (schema queue.order.v1); an action prints queue.action.v1`;

export interface QueueOrderCli { read: typeof readQueueOrder; steer: typeof steerQueue }

/** True when the arguments name one of the steering actions. */
const isQueueOrderAction = (word: string | undefined): word is QueueOrderAction => QUEUE_ORDER_ACTIONS.includes(word as QueueOrderAction);

export async function cmdQueueOrder(args: string[], cli: QueueOrderCli = { read: readQueueOrder, steer: steerQueue }): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(QUEUE_ORDER_HELP); return 0; }
  const json = args.includes('--json'), dryRun = args.includes('--dry-run');
  const words = args.filter(arg => arg !== '--json' && arg !== '--dry-run');
  const [action, id, lane] = words;
  const want = action === undefined ? 0 : action === 'lane' ? 3 : 2;
  if (words.some(word => word.startsWith('-')) || words.length !== want || (action !== undefined && !isQueueOrderAction(action)) || (action === undefined && dryRun)) {
    console.error(QUEUE_ORDER_HELP); return 2;
  }
  try {
    if (action === undefined) {
      const order = await cli.read();
      console.log(json ? JSON.stringify(order) : queueOrderText(order).join('\n'));
      return 0;
    }
    const report = await cli.steer({ action, id, ...(lane === undefined ? {} : { lane }), dryRun } as QueueActionRequest, { by: 'cli' });
    console.log(json ? JSON.stringify(report) : report.message);
    return report.verified === false ? 1 : 0;
  } catch (error) {
    const message = error instanceof QueueSteerError ? error.message : 'The queue is unavailable.';
    if (json) console.log(JSON.stringify({ error: message, ...(error instanceof QueueSteerError ? { code: error.code } : {}) })); else console.error(message);
    return 1;
  }
}
