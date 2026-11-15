import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.js';
import { ingestSignal, sendReceipts, SIGNAL_KINDS, telegramNotifier, SEVERITIES, type IncidentSignal } from '../core/incident/pipeline.js';
import { QueueStore } from '../core/queue/store.js';

const HELP = `Usage: phm incident report --kind <${SIGNAL_KINDS.join('|')}> --repo <repo> --message <text> [--source <name>] [--service <name>] [--count <n>] [--severity <${SEVERITIES.join('|')}>] [--dir <queue-directory>] [--json]
       phm incident receipts [--dir <queue-directory>] [--json]
Turns a production signal into one bounded READY fix job. Repeats of the same
error join the open incident instead of queueing again, hourly caps limit how
many jobs a noisy source can open, and severity picks priority and tier (sev4 is
only recorded). "receipts" messages the reporter once for each incident whose job
is DONE. Messages go to Telegram only when proactive comms are on.`;

export async function cmdIncident(args: string[]): Promise<number> {
  let json = args.includes('--json');
  try {
    const [verb, ...rest] = args;
    const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: {
      json: { type: 'boolean' }, dir: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      kind: { type: 'string' }, repo: { type: 'string' }, message: { type: 'string' }, source: { type: 'string' },
      service: { type: 'string' }, count: { type: 'string' }, severity: { type: 'string' },
    } });
    json = values.json === true;
    if (values.help || !verb || verb === '--help' || verb === '-h') { console.log(HELP); return verb || values.help ? 0 : 1; }
    const deps = { store: new QueueStore(values.dir), notify: telegramNotifier(loadConfig()) };
    let out: unknown, text: string;
    if (verb === 'report') {
      const signal = { kind: values.kind, repo: values.repo, message: values.message, source: values.source ?? 'cli', service: values.service,
        count: values.count === undefined ? undefined : Number(values.count), severity: values.severity } as IncidentSignal;
      const result = await ingestSignal(signal, deps);
      out = result;
      text = result.status === 'invalid' ? `Rejected: ${result.reason}` : result.status === 'enqueued' ? `Queued ${result.jobId} (${result.severity}${result.regression ? ', regression' : ''}).`
        : result.status === 'duplicate' ? `Already open as ${result.jobId}.` : result.status === 'rate-limited' ? `Rate limited: ${result.reason}.` : `Recorded ${result.severity}; no job queued.`;
      if (result.status === 'invalid') { console.error(json ? JSON.stringify(result) : text); return 1; }
    } else if (verb === 'receipts') {
      const receipts = await sendReceipts(deps);
      out = { v: 1, receipts };
      text = receipts.length ? `Sent ${receipts.length} receipt${receipts.length === 1 ? '' : 's'}.` : 'No receipts due.';
    } else { console.error(HELP); return 1; }
    console.log(json ? JSON.stringify(out) : text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Incident pipeline unavailable';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
