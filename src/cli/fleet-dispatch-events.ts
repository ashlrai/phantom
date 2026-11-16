/** Read-only view of the dispatcher's text event log; never launches or publishes. */
import { readDispatchEvents } from '../core/fabric/dispatch-events.js';

const usage = 'Usage: phm fleet dispatch-events [--since <ISO timestamp>] [--file <path>] [--json]';

/** `phm fleet dispatch-events`: parse dispatch-events.log rows (recut of #1166). */
export async function cmdFleetDispatchEvents(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const seen = new Set<string>();
  let since: string | undefined;
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--json', '--since', '--file'].includes(flag) || seen.has(flag)) {
      console.error(`fleet dispatch-events: unexpected or repeated argument\n${usage}`);
      return 2;
    }
    seen.add(flag);
    if (flag === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('--')) {
      console.error(`fleet dispatch-events: ${flag} requires a value\n${usage}`);
      return 2;
    }
    if (flag === '--since') since = value;
    else path = value;
  }
  try {
    const report = await readDispatchEvents({ since, path });
    if (seen.has('--json')) {
      console.log(JSON.stringify(report));
      return 0;
    }
    for (const event of report.events) {
      console.log(`${event.timestamp} ${event.kind}${event.message ? ` ${event.message}` : ''}`);
    }
    if (report.source === 'missing') console.error('Dispatch event log is missing.');
    if (report.truncated) console.error(`Showing the newest ${report.events.length}; ${report.truncated} older event(s) omitted.`);
    if (report.malformedLines) console.error(`Skipped ${report.malformedLines} malformed dispatch event line(s).`);
    return 0;
  } catch (error) {
    // Never echo file contents; the --since message is ours and safe to print.
    const detail = error instanceof Error && error.message.startsWith('--since') ? error.message : 'unable to read the log';
    console.error(`fleet dispatch-events: ${detail}`);
    return 1;
  }
}
