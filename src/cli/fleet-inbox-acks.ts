/** Show which recent MASON-INBOX entries are acknowledged on their channel; --flush sends the pending acks now. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeInboxEntries, type InboxAckSenders } from '../core/fleet/inbox-ack.js';
import { readInboxAcks, type InboxAckReportRow, type InboxAcksRead } from '../core/fleet/inbox-acks-read.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet inbox-acks [--runs-dir <path>] [--limit <1-200>] [--flush] [--json]';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface FleetInboxAcksDeps {
  /** Injected senders for tests; production uses the senders in inbox-ack.ts. */
  senders?: InboxAckSenders;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Overrides --runs-dir / ASHLR_RUNS_DIR / ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => Date;
}

type State = InboxAckReportRow['state'];

export async function cmdFleetInboxAcks(args: string[], deps: FleetInboxAcksDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output(`${usage}\nList the ack state (acked, skipped, pending, no-channel) of the newest MASON-INBOX entries. --flush sends pending acks now through the planner brief's senders. Exit 2 on invalid arguments.`);
    return 0;
  }
  let runsFlag: string | undefined;
  let limit = DEFAULT_LIMIT;
  let flush = false;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--flush') flush = true;
    else if (arg === '--json') json = true;
    else if (arg === '--runs-dir' || arg === '--limit') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return invalid();
      if (arg === '--runs-dir') runsFlag = value;
      else {
        if (!/^\d{1,3}$/.test(value)) return invalid();
        limit = Number(value);
        if (limit < 1 || limit > MAX_LIMIT) return invalid();
      }
    } else return invalid();
  }
  const runsDir = runsFlag ?? deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = deps.now ?? (() => new Date());

  let read: InboxAcksRead = await readInboxAcks({ runsDir, limit });
  if (flush) {
    const pending = read.entries.filter(row => row.state === 'pending').map(row => row.raw);
    await acknowledgeInboxEntries(pending, runsDir, now().toISOString(), deps.senders);
    read = await readInboxAcks({ runsDir, limit });
  }
  const rows = read.entries;
  const count = (s: State): number => rows.filter(r => r.state === s).length;
  const totals = { acked: count('acked'), skipped: count('skipped'), pending: count('pending'), noChannel: count('no-channel') };
  if (json) {
    output(JSON.stringify({
      v: 1, generatedAt: now().toISOString(),
      entries: rows.map(r => ({ entryId: r.entryId, channel: r.channel, state: r.state, ...(r.reason ? { reason: r.reason } : {}), ...(r.ackedBy ? { ackedBy: r.ackedBy } : {}) })),
      totals, malformedLedgerRows: read.malformedLedgerRows,
    }));
    return 0;
  }
  for (const r of rows) {
    const preview = scrubSecrets(r.text).replace(/\s+/g, ' ').trim().slice(0, 60);
    const state = r.state === 'skipped' && r.reason ? `skipped (${r.reason})` : r.state;
    const why = r.ackedBy ? `  [${r.ackedBy}]` : r.reason && r.state !== 'skipped' ? `  [${r.reason}]` : '';
    output(`${state}  ${r.channel ?? '-'}  ${r.entryId.slice(0, 12)}  ${preview}${why}`);
  }
  output(`Totals: ${totals.acked} acked, ${totals.skipped} skipped, ${totals.pending} pending, ${totals.noChannel} no-channel`
    + (read.malformedLedgerRows ? `; ${read.malformedLedgerRows} malformed ledger row${read.malformedLedgerRows === 1 ? '' : 's'} ignored` : ''));
  return 0;

  function invalid(): number {
    error(`error: invalid arguments. ${usage}`);
    return 2;
  }
}
