/** Show which recent MASON-INBOX entries are acknowledged on their channel; --flush sends the pending acks now. */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeInboxEntries, inboxAckEntry, type InboxAckSenders } from '../core/fleet/inbox-ack.js';
import { INBOX_CHANNEL_LINE, INBOX_HEADING } from '../core/fleet/inbox-channel-line.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet inbox-acks [--runs-dir <path>] [--limit <1-200>] [--flush] [--json]';
const INBOX_BUDGET = 256 * 1024;
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

type State = 'acked' | 'skipped' | 'pending' | 'no-channel';
interface Row { entryId: string; channel: string | null; state: State; reason?: string; text: string }

function readTail(file: string): string {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - INBOX_BUDGET);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const text = buf.subarray(0, got).toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch { return ''; } finally { closeSync(fd); }
}

/** Whole entries (heading line plus body), oldest first, split like planner-brief.ts. */
function splitEntries(text: string): string[] {
  const entries: Array<{ heading: string; body: string[] }> = [];
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  for (const line of lines) {
    if (INBOX_HEADING.test(line) || (INBOX_CHANNEL_LINE.test(line) && Number.isFinite(Date.parse(line.split(/\s/, 1)[0]!)))) entries.push({ heading: line, body: [] });
    else if (entries.length) entries[entries.length - 1]!.body.push(line);
  }
  return entries.map(e => [e.heading, ...e.body].join('\n'));
}

function readLedger(runsDir: string): { done: Map<string, { status: string; reason?: string }>; malformed: number } {
  const done = new Map<string, { status: string; reason?: string }>();
  let malformed = 0;
  let text = '';
  try { text = readFileSync(join(runsDir, 'queue', 'inbox-acks.jsonl'), 'utf8'); } catch { return { done, malformed }; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { entryId?: unknown; status?: unknown; reason?: unknown };
      if (typeof row.entryId !== 'string' || typeof row.status !== 'string') { malformed++; continue; }
      if ((row.status === 'acked' || row.status === 'skipped') && !done.has(row.entryId)) {
        done.set(row.entryId, { status: row.status, ...(typeof row.reason === 'string' ? { reason: row.reason } : {}) });
      }
    } catch { malformed++; }
  }
  return { done, malformed };
}

function report(raws: readonly string[], runsDir: string): { rows: Row[]; malformed: number } {
  const { done, malformed } = readLedger(runsDir);
  const rows = raws.map((raw): Row => {
    const entry = inboxAckEntry(raw, '');
    const hit = done.get(entry.entryId);
    const base = { entryId: entry.entryId, channel: entry.channel, text: entry.text || raw };
    if (hit?.status === 'acked') return { ...base, state: 'acked' };
    if (hit?.status === 'skipped') return { ...base, state: 'skipped', ...(hit.reason ? { reason: hit.reason } : {}) };
    return { ...base, state: entry.channel ? 'pending' : 'no-channel' };
  });
  return { rows, malformed };
}

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
  const raws = splitEntries(readTail(join(runsDir, 'leader', 'MASON-INBOX.md'))).slice(-limit);
  const now = deps.now ?? (() => new Date());

  let result = report(raws, runsDir);
  if (flush) {
    const pending = raws.filter((_, i) => result.rows[i]!.state === 'pending');
    await acknowledgeInboxEntries(pending, runsDir, now().toISOString(), deps.senders);
    result = report(raws, runsDir);
  }
  const { rows, malformed } = result;
  const count = (s: State): number => rows.filter(r => r.state === s).length;
  const totals = { acked: count('acked'), skipped: count('skipped'), pending: count('pending'), noChannel: count('no-channel') };
  if (json) {
    output(JSON.stringify({
      v: 1, generatedAt: now().toISOString(),
      entries: rows.map(r => ({ entryId: r.entryId, channel: r.channel, state: r.state, ...(r.reason ? { reason: r.reason } : {}) })),
      totals, malformedLedgerRows: malformed,
    }));
    return 0;
  }
  for (const r of rows) {
    const preview = scrubSecrets(r.text).replace(/\s+/g, ' ').trim().slice(0, 60);
    const state = r.state === 'skipped' && r.reason ? `skipped (${r.reason})` : r.state;
    output(`${state}  ${r.channel ?? '-'}  ${r.entryId.slice(0, 12)}  ${preview}`);
  }
  output(`Totals: ${totals.acked} acked, ${totals.skipped} skipped, ${totals.pending} pending, ${totals.noChannel} no-channel`
    + (malformed ? `; ${malformed} malformed ledger row${malformed === 1 ? '' : 's'} ignored` : ''));
  return 0;

  function invalid(): number {
    error(`error: invalid arguments. ${usage}`);
    return 2;
  }
}
