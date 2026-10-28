import { readDispatchEvents } from '../core/fabric/dispatch-events.js';

export async function cmdFleetEvents(args: string[]): Promise<number> {
  const usage = 'phm fleet events [--since <ISO timestamp>] [--file <path>] [--json]';
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
      console.error(`fleet events: unexpected or repeated argument\nusage: ${usage}`);
      return 2;
    }
    seen.add(flag);
    if (flag === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('--')) {
      console.error(`fleet events: ${flag} requires a value\nusage: ${usage}`);
      return 2;
    }
    if (flag === '--since') since = value;
    else path = value;
  }
  try {
    const report = await readDispatchEvents({ since, path });
    if (args.includes('--json')) console.log(JSON.stringify(report));
    else {
      for (const event of report.events) {
        console.log(`${event.timestamp} ${event.kind}${event.message ? ` ${event.message}` : ''}`);
      }
      if (report.source === 'missing') console.error('Dispatch event log is missing.');
      if (report.malformedLines) console.error(`Skipped ${report.malformedLines} malformed dispatch event line(s).`);
    }
    return 0;
  } catch {
    console.error('fleet events: unable to read log or invalid --since (use an ISO timestamp with a timezone).');
    return 1;
  }
}
