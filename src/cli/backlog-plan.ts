/** The bridge owns collection, queue application and scheduling. This command reads only. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { formatRqQueue, parseRqConfig, planRqBacklog, RQ_MAX_FILE_BYTES, rqDigest, rqQueueDiff, type RqConfig } from '../core/portfolio/rq-backlog.js';

export const BACKLOG_PLAN_USAGE = 'phm backlog plan --config <config.json> --input <sources.json> --queue <router-queue.md> [--previous-queue <snapshot.md>]';

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

function auditQueue(before: string, after: string, config: RqConfig) {
  try {
    const diff = rqQueueDiff(before, after, config);
    console.error(JSON.stringify(diff));
    return diff;
  } catch {
    console.error(JSON.stringify({ event: 'rq-queue-read', beforeSha: rqDigest(before), sha: rqDigest(after), verdict: 'reject' }));
    throw new Error('Invalid queue snapshot');
  }
}

export async function cmdBacklogPlan(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(BACKLOG_PLAN_USAGE);
    console.log('Offline, read-only. stdout: READY JSON Lines; stderr: structured queue diff and capacity.');
    return 0;
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!['--config', '--input', '--queue', '--previous-queue'].includes(flag) || flags.has(flag) || !value || value.startsWith('--')) {
      console.error(JSON.stringify({ event: 'rq-plan-error', code: 'usage' }));
      return 2;
    }
    flags.set(flag, value);
  }
  if (!['--config', '--input', '--queue'].every((flag) => flags.has(flag))) {
    console.error(JSON.stringify({ event: 'rq-plan-error', code: 'usage' }));
    return 2;
  }
  try {
    const config = parseRqConfig(JSON.parse(await readSnapshot(flags.get('--config')!)) as unknown);
    let previous = '';
    if (flags.has('--previous-queue')) {
      previous = await readSnapshot(flags.get('--previous-queue')!);
      auditQueue('', previous, config);
    }
    const queue = await readSnapshot(flags.get('--queue')!);
    const diff = auditQueue(previous, queue, config);
    const sources: unknown = JSON.parse(await readSnapshot(flags.get('--input')!));
    const plan = planRqBacklog(config, sources, queue);
    console.error(JSON.stringify({
      event: 'rq-plan', sha: diff.sha, ready: plan.ready, minimum: plan.minimum,
      target: plan.target, added: plan.jobs.length, shortfall: plan.shortfall,
    }));
    const output = formatRqQueue(plan.jobs);
    if (output) process.stdout.write(output);
    return plan.shortfall > 0 ? 1 : 0;
  } catch {
    // Neither source text nor filesystem errors (which can contain private
    // paths) belong in logs. Invalid/absent queues must never count as empty.
    console.error(JSON.stringify({ event: 'rq-plan-error', code: 'invalid-snapshot' }));
    return 2;
  }
}
