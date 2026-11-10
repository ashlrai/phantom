import { parseArgs } from 'node:util';
import { readRunEventLog, replayRunState, runBranches, runHead, runEventLogPath, RunEventLogError } from '../core/events/run-event-reader.js';

const usage = 'Usage: phm fleet run-events <list|head|branches|replay> <job> [--runs-dir <absolute>] [--at <event>] [--branch <name>] [--json]';

/** Read the original event-tree artifacts without changing them. */
export async function cmdFleetRunEvents(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean' },
      'runs-dir': { type: 'string' }, at: { type: 'string' }, branch: { type: 'string' },
    } });
  } catch {
    console.error('Invalid arguments');
    return 2;
  }
  const [command, job, ...extra] = parsed.positionals;
  if (parsed.values.help || command === 'help') {
    console.log(usage);
    return 0;
  }
  if (!command || !['list', 'head', 'branches', 'replay'].includes(command) || !job || extra.length) {
    console.error('Expected <list|head|branches|replay> <job>');
    return 2;
  }
  try {
    const runsDir = parsed.values['runs-dir'] as string | undefined;
    const read = await readRunEventLog(job, { runsDir });
    const result = command === 'list'
      ? { job, path: runEventLogPath(job, runsDir), head: runHead(read.events), deferred: read.deferred,
        events: parsed.values.branch ? read.events.filter(e => e.branch === parsed.values.branch) : read.events }
      : command === 'head' ? { job, ...runHead(read.events), deferred: read.deferred }
        : command === 'branches' ? { job, branches: runBranches(read.events), deferred: read.deferred }
          : replayRunState(job, read, { at: parsed.values.at as string | undefined });
    console.log(JSON.stringify(result, null, parsed.values.json ? undefined : 2));
    return 0;
  } catch (error) {
    const code = error instanceof RunEventLogError ? error.code : 'error';
    const message = error instanceof RunEventLogError ? error.message : 'Event log operation failed';
    if (parsed.values.json) console.log(JSON.stringify({ error: message, code }));
    else console.error(message);
    return 1;
  }
}
