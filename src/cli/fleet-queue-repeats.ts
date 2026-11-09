import { readFile } from 'node:fs/promises';
import { queueRepeats, validQueueLines } from '../core/fleet/queue-repeats.js';
export { queueRepeats };
export type { QueueLine, QueueRepeat } from '../core/fleet/queue-repeats.js';

const usage = 'Usage: phm fleet queue-repeats --lines <lines.json> [--json]\nRead-only. Counts READY or CLAIMED lines from the last 24 hours that repeat an earlier line with the same repo, target file and acceptance, and shows the top 5. JSON array: [{"id":"RQ-1","status":"READY","repo":"lexicon","at":"2026-01-01T00:00:00Z","text":"Edit schema.test.ts ... Acceptance: ..."}]. Lines with no target file or Acceptance clause are never matched.';

export async function cmdFleetQueueRepeats(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--lines' && !path && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i];
    else { console.error(usage); return 2; }
  }
  if (!path) { console.error(usage); return 2; }
  try {
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validQueueLines(input)) throw new Error('Invalid lines');
    const report = queueRepeats(input);
    if (json) console.log(JSON.stringify(report));
    else {
      console.log(`Repeats: ${report.repeats}`);
      for (const row of report.examples) console.log(`${row.id} repeats ${row.repeatOf} (${row.repo}, ${row.file}); queued ${row.group.length} times`);
    }
    return 0;
  } catch { console.error('error: unable to read valid queue lines; use --help for the format'); return 1; }
}
