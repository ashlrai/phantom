/** The bridge owns collection, queue application and scheduling. This command reads only. */
import {
  formatRqQueue,
  parseRqConfig,
  planRqBacklog,
  readBoundedRqSnapshot,
  rqDigest,
  rqQueueDiff,
  type RqConfig,
} from '../core/portfolio/rq-backlog.js';

const BACKLOG_PLAN_USAGE = 'phm backlog plan --config <config.json> --input <sources.json> --queue <router-queue.md> [--previous-queue <snapshot.md>] [--report-json]';

type QueueAudit = ReturnType<typeof rqQueueDiff> | { event: 'rq-queue-read'; beforeSha: string; sha: string; verdict: 'reject' };

function auditQueue(before: string, after: string, config: RqConfig, record: (audit: QueueAudit) => void) {
  try {
    const diff = rqQueueDiff(before, after, config);
    record(diff);
    return diff;
  } catch {
    record({ event: 'rq-queue-read', beforeSha: rqDigest(before), sha: rqDigest(after), verdict: 'reject' });
    throw new Error('Invalid queue snapshot');
  }
}

export async function cmdBacklogPlan(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(BACKLOG_PLAN_USAGE);
    console.log('Offline, read-only. Default stdout: READY JSON Lines; stderr: queue diff and capacity. --report-json: one versioned stdout report.');
    return 0;
  }
  const report = args.includes('--report-json');
  const audits: QueueAudit[] = [];
  const record = (audit: QueueAudit) => {
    if (report) audits.push(audit);
    else console.error(JSON.stringify(audit));
  };
  const error = (code: 'usage' | 'invalid-snapshot') => {
    if (report) console.log(JSON.stringify({ v: 1, event: 'rq-plan-report', status: 'error', error: { code }, audits }));
    else console.error(JSON.stringify({ event: 'rq-plan-error', code }));
    return 2;
  };
  const flags = new Map<string, string>();
  let reportSeen = false;
  for (let index = 0; index < args.length;) {
    const flag = args[index]!;
    if (flag === '--report-json') {
      if (reportSeen) return error('usage');
      reportSeen = true;
      index++;
      continue;
    }
    const value = args[index + 1];
    if (!['--config', '--input', '--queue', '--previous-queue'].includes(flag) || flags.has(flag) || !value || value.startsWith('-')) {
      return error('usage');
    }
    flags.set(flag, value);
    index += 2;
  }
  if (!['--config', '--input', '--queue'].every((flag) => flags.has(flag))) {
    return error('usage');
  }
  try {
    const config = parseRqConfig(JSON.parse(await readBoundedRqSnapshot(flags.get('--config')!)) as unknown);
    let previous = '';
    if (flags.has('--previous-queue')) {
      previous = await readBoundedRqSnapshot(flags.get('--previous-queue')!);
      auditQueue('', previous, config, record);
    }
    const queue = await readBoundedRqSnapshot(flags.get('--queue')!);
    const diff = auditQueue(previous, queue, config, record);
    const sourceText = await readBoundedRqSnapshot(flags.get('--input')!);
    const sources: unknown = JSON.parse(sourceText);
    const plan = planRqBacklog(config, sources, queue);
    const capacity = {
      event: 'rq-plan', sha: diff.sha, ready: plan.ready, minimum: plan.minimum,
      target: plan.target, added: plan.jobs.length, shortfall: plan.shortfall,
      parked: plan.parked,
    };
    if (report) {
      console.log(JSON.stringify({
        v: 1, event: 'rq-plan-report', status: 'ok', items: plan.jobs, capacity,
        digests: { source: rqDigest(sourceText), queue: diff.sha }, audits,
      }));
    } else {
      console.error(JSON.stringify(capacity));
      const output = formatRqQueue(plan.jobs);
      if (output) process.stdout.write(output);
    }
    return plan.shortfall > 0 ? 1 : 0;
  } catch {
    // Neither source text nor filesystem errors (which can contain private
    // paths) belong in logs. Invalid/absent queues must never count as empty.
    return error('invalid-snapshot');
  }
}
