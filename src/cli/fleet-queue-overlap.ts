import { queueOverlap, type QueueOverlapReport } from '../core/queue/overlap.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet queue-overlap <prompt-file> [--json]\nCheck named files against local default-branch, open-PR and queue evidence. Writes nothing.';
export async function cmdFleetQueueOverlap(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const files = args.filter(arg => arg !== '--json'), json = args.includes('--json');
  if (files.length !== 1 || files[0]!.startsWith('-') || args.length > (json ? 2 : 1)) { console.error(usage); return 2; }
  try {
    const report = sanitizePublicJson(await queueOverlap(files[0]!)) as QueueOverlapReport;
    console.log(json ? JSON.stringify(report) : [
      `Default branch: ${report.defaultBranchPaths?.join(', ') || (report.defaultBranchPaths === null ? 'unknown' : 'no named files found')}`,
      `Open PRs: ${report.openPrs === null ? 'unknown' : report.openPrs.length ? report.openPrs.map(pr => `#${pr.number}: ${pr.paths.join(', ')}`).join('; ') : 'no matching paths'}`,
      `Queued work: ${report.queued === null ? 'unknown' : report.queued.length ? report.queued.map(job => `${job.id}: ${job.paths.join(', ')}`).join('; ') : 'no matching paths'}`,
      ...report.gaps.map(gap => `Gap: ${gap}`),
    ].join('\n'));
    return 0;
  } catch {
    const error = 'Cannot read prompt; use a regular file of at most 4 MiB.';
    if (json) console.log(JSON.stringify({ schema: 'queue.overlap.v1', error })); else console.error(error);
    return 1;
  }
}
