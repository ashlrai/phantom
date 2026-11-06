/** The bridge owns collection, queue application and scheduling. This command reads only. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { formatRqQueue, parseRqConfig, planRqBacklog, RQ_MAX_FILE_BYTES, rqDigest, rqQueueDiff, type RqConfig } from '../core/portfolio/rq-backlog.js';

export const BACKLOG_PLAN_USAGE = 'phm backlog plan --config <config.json> --input <sources.json> --queue <router-queue.md> [--previous-queue <snapshot.md>] [--report-json]';

async function readSnapshot(path: string): Promise<string> {
  // One bounded read through the same descriptor: size checks cannot be
  // defeated by replacing/growing a file between stat and readFile.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > RQ_MAX_FILE_BYTES) throw new Error('Invalid snapshot file');
    const buffer = Buffer.alloc(RQ_MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > RQ_MAX_FILE_BYTES) throw new Error('Snapshot is too large');
    // Preserve BOM bytes in decoded text: silently stripping them would make
    // the queue SHA differ from the actual file. JSON validation rejects BOMs.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

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
    const config = parseRqConfig(JSON.parse(await readSnapshot(flags.get('--config')!)) as unknown);
    let previous = '';
    if (flags.has('--previous-queue')) {
      previous = await readSnapshot(flags.get('--previous-queue')!);
      auditQueue('', previous, config, record);
    }
    const queue = await readSnapshot(flags.get('--queue')!);
    const diff = auditQueue(previous, queue, config, record);
    const sourceText = await readSnapshot(flags.get('--input')!);
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
