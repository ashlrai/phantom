import { parseArgs } from 'node:util';
import { groupIssues, retryIssues, type IssueReport, type IssueRetry } from '../core/queue/issues.js';
import { QueueStore } from '../core/queue/store.js';

const HELP = `Usage: phm issues [--retry] [--dir <queue-directory>] [--json]
Groups failed queue jobs by what went wrong. Ids and times are ignored, so the
same problem counts once. Shows each group's count and a few example job ids.
Read-only unless you add --retry, which queues one READY retry per failed job.
Run it again after --retry and it will not queue duplicates.`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatIssues(report: IssueReport): string {
  if (!report.failed) return 'No failed jobs.';
  const lines = [`${plural(report.failed, 'failed job')}, ${plural(report.groups.length, 'kind')} of error.`];
  for (const group of report.groups) {
    lines.push('', `${group.count} x ${group.error}`, `    e.g. ${group.samples.join(', ')}`);
  }
  return lines.join('\n');
}

export function formatRetry(result: IssueRetry): string {
  return result.retried.length ? `Queued ${plural(result.retried.length, 'retry')} as READY.` : 'Nothing to retry.';
}

export async function cmdIssues(args: string[]): Promise<number> {
  let json = args.includes('--json');
  try {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      json: { type: 'boolean' }, retry: { type: 'boolean' }, dir: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    json = values.json === true;
    if (values.help) { console.log(HELP); return 0; }
    const store = new QueueStore(values.dir);
    if (values.retry) {
      const result = await retryIssues(store);
      console.log(json ? JSON.stringify(result) : formatRetry(result));
    } else {
      const report = groupIssues(await store.read());
      console.log(json ? JSON.stringify(report) : formatIssues(report));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Issues unavailable';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
