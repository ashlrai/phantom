import { readFile } from 'node:fs/promises';
import { buildMergeDelay, type MergeDelayEvent } from '../core/fleet/merge-delay.js';

export { buildMergeDelay };
export type { MergeDelayEvent };
const usage = 'Usage: ashlr fleet merge-delay --input <events.json> [--json]';
export interface FleetMergeDelayDeps {
  readEvents?: (path: string) => Promise<readonly MergeDelayEvent[]>;
  now?: () => Date;
  output?: { log: (message: string) => void; error: (message: string) => void };
}
export async function cmdFleetMergeDelay(args: string[], deps: FleetMergeDelayDeps = {}): Promise<number> {
  const out = deps.output ?? console;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    out.log(`${usage}\nRead a JSON array of {repo, pr, event, at}. Events: published, auto_merge_enabled, merged; at is an ISO timestamp. Reports seconds; missing stages stay unknown. Enrollment stalls after 30 minutes. Duplicate events use the earliest timestamp. No network calls.`);
    return 0;
  }
  let input: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--input' && !input && args[i + 1] && !args[i + 1]!.startsWith('-')) input = args[++i];
    else { out.error(usage); return 2; }
  }
  if (!input) { out.error(usage); return 2; }
  try {
    const events: unknown = await (deps.readEvents ?? (async path => JSON.parse(await readFile(path, 'utf8')) as MergeDelayEvent[]))(input);
    if (!Array.isArray(events)) throw new Error('Expected event array');
    const report = buildMergeDelay(events, (deps.now ?? (() => new Date()))());
    out.log(json ? JSON.stringify(report) : report.rows.map(r =>
      `${r.repo}#${r.pr}: ${r.status}${r.stalledEnrollment ? ' (enrollment stalled)' : ''}; publication to enrollment: ${r.publicationToEnrollmentSeconds ?? 'unknown'} s; enrollment to merge: ${r.enrollmentToMergeSeconds ?? 'unknown'} s; total: ${r.publicationToMergeSeconds ?? 'unknown'} s; enrollment wait: ${r.enrollmentWaitSeconds ?? 'unknown'} s; merge wait: ${r.mergeWaitSeconds ?? 'unknown'} s`).join('\n') || 'No PR events found.');
    return 0;
  } catch {
    out.error('Cannot report merge delay: input must be a readable JSON event array with valid PRs and timestamps no later than now.');
    return 1;
  }
}
