import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { boxStationEvents, publicationReceipt, queueJob, stationCoverage } from '../core/observability/router-queue.js';
import { appendStationEvents, readStationEvents } from '../core/observability/router-queue-store.js';
import { pollQueueGithub, type QueueGh } from '../core/observability/router-queue-github.js';

const HELP = `Usage: phm telemetry queue <observe|publish|poll|status> [options]
  observe --input snapshot.json     Diff normalized router queue + claim ledger + publications
  publish --input receipt.json      Record only after the box publish.sh succeeds
  poll --input receipt.json         Read PR CI, merge queue, merge, release and main CI via Locus
  status --job ID --repo OWNER/REPO --attempt ID [--require-complete]
  --journal PATH                    Private durable event journal (default: ~/.ashlr/telemetry/router-queue/events.json)
Output is JSON. Poll exits 1 on unavailable evidence; status --require-complete exits 1 for missing stations.
No command publishes, merges, releases, repairs main, or changes GitHub.
See docs/ROUTER-QUEUE-STATIONS.md for the versioned input contracts.
`;

function input(path: string): unknown {
  const absolute = resolve(path);
  const result = readStableRegularFile(absolute, { anchorPath: dirname(absolute), maxFileBytes: 4 * 1024 * 1024, remainingBytes: 4 * 1024 * 1024 });
  if (!result.ok) throw new Error('Queue input is missing, unsafe, changed, or oversized');
  try { return JSON.parse(result.text) as unknown; }
  catch { throw new Error('Queue input must be valid JSON'); }
}

export interface QueueCliDeps {
  now?: () => Date;
  github?: <T>(fn: (gh: QueueGh) => Promise<T>) => Promise<T>;
  write?: (text: string) => void;
  error?: (text: string) => void;
}

/** Injectable output/clock/transport keep tests offline; the production transport
 * is lazy so observe, publish and status never need an account or provider CLI. */
export async function cmdRouterQueue(args: string[], deps: QueueCliDeps = {}): Promise<number> {
  const write = deps.write ?? (text => { process.stdout.write(text); });
  const error = deps.error ?? (text => { process.stderr.write(text); });
  if (args.length === 0 || ['help', '--help', '-h'].includes(args[0]!)) { write(HELP); return 0; }
  const sub = args[0];
  if (!['observe', 'publish', 'poll', 'status'].includes(sub!)) { error('Unknown queue command\n'); return 2; }
  const allowed = sub === 'status' ? ['--job', '--repo', '--attempt', '--journal', '--require-complete'] : ['--input', '--journal'];
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (!allowed.includes(flag) || flags.has(flag)) { error('Invalid or duplicate queue option\n'); return 2; }
    if (flag === '--require-complete') { flags.set(flag, 'true'); continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { error('Queue option requires a value\n'); return 2; }
    flags.set(flag, value);
  }
  if (sub === 'status' ? !['--job', '--repo', '--attempt'].every(flag => flags.has(flag)) : !flags.has('--input')) {
    error('Missing required queue option\n'); return 2;
  }
  const journal = resolve(flags.get('--journal') ?? join(homedir(), '.ashlr', 'telemetry', 'router-queue', 'events.json'));
  try {
    if (sub === 'status') {
      const job = queueJob({ jobId: flags.get('--job'), repo: flags.get('--repo'), attempt: flags.get('--attempt') });
      const coverage = stationCoverage(readStationEvents(journal), job);
      write(JSON.stringify({ schemaVersion: 1, ...job, ...coverage }) + '\n');
      return flags.has('--require-complete') && !coverage.complete ? 1 : 0;
    }
    const value = input(flags.get('--input')!); const observedAt = (deps.now?.() ?? new Date()).toISOString();
    if (sub === 'observe' || sub === 'publish') {
      const snapshot = sub === 'publish' ? { schemaVersion: 1, queue: [], claims: [], publications: [publicationReceipt(value)] } : value;
      const result = appendStationEvents(journal, boxStationEvents(snapshot, observedAt));
      write(JSON.stringify({ schemaVersion: 1, added: result.added.length, events: result.added }) + '\n');
      return 0;
    }
    const receipt = publicationReceipt(value);
    const github = deps.github ?? (await import('../core/observability/router-queue-locus.js')).withQueueGithub;
    const polled = await github(gh => pollQueueGithub(receipt, gh, observedAt));
    const result = appendStationEvents(journal, polled.events);
    write(JSON.stringify({ schemaVersion: 1, added: result.added.length, events: result.added,
      unavailable: polled.unavailable, ...stationCoverage(result.events, receipt) }) + '\n');
    return polled.unavailable.length === 0 ? 0 : 1;
  } catch {
    // Filesystem, JSON, Locus and subprocess errors may contain account data or
    // raw input. They must never cross this values-free CLI boundary.
    error('Queue observation failed: check input contract, private journal, and verified Locus session for polling\n');
    return 1;
  }
}
