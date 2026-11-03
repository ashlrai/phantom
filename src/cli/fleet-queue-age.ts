import { readFile } from 'node:fs/promises';
import { queueAge, validQueueAgeEvents } from '../core/fleet/queue-age.js';
export { queueAge };
export type { QueueAgeEvent } from '../core/fleet/queue-age.js';

const usage = 'Usage: phm fleet queue-age --events <events.json> [--json]\nRead-only PR delays, longest first. JSON array: [{"pr":"owner/repo#1","event":"created","ts":"2026-01-01T00:00:00Z"}]. Events: created, queue_entered, merged. Repeated distinct boundaries are ambiguous; missing or reversed times stay unmeasured.';
const labels = { creation_to_queue: 'creation to queue', queue_to_merge: 'queue to merge', creation_to_merge: 'creation to merge' };

export async function cmdFleetQueueAge(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--events' && !path && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i];
    else { console.error(usage); return 2; }
  }
  if (!path) { console.error(usage); return 2; }
  try {
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validQueueAgeEvents(input)) throw new Error('Invalid events');
    const report = queueAge(input);
    if (json) console.log(JSON.stringify(report));
    else {
      if (!report.prs) console.log('No PR events.');
      for (const delay of report.oldest_delays) console.log(`${delay.pr}: ${labels[delay.phase]} took ${delay.seconds}s`);
      for (const row of report.entries) for (const delay of row.delays) {
        if (delay.reason) console.log(`${row.pr}: ${labels[delay.phase]} unmeasured (${delay.reason} times)`);
      }
    }
    return 0;
  } catch { console.error('error: unable to read valid PR events; use --help for the format'); return 1; }
}
