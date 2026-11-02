/**
 * `phm channels` — one obvious path to bring a channel up or check it.
 *
 * Subcommands:
 *   add telegram <chat-id>                     Write comms.telegram config. The bot
 *                                              token stays in existing custody —
 *                                              TELEGRAM_BOT_TOKEN or
 *                                              comms.telegram.botToken — and is
 *                                              never accepted or printed here.
 *   add email <inboxDir> --from <a> [...]      Write queue/email-drop.json. The
 *                                              pairing secret stays in
 *                                              PHANTOM_OPERATOR_SECRET or
 *                                              ~/.ashlr/comms/operator-secret.
 *   add mobile|cli|desktop|page                No config to write — prints the
 *                                              built-in/gateway path instead.
 *   status [--json]                            Per-channel rollup: configured,
 *                                              credential custody, pairing, inbox
 *                                              counts, pending outbound. Counts
 *                                              are measured; 'unknown' when a
 *                                              source cannot be read.
 *
 * `add` is configuration only: it starts no transport, pairs nothing, and never
 * prints a secret value. Exit codes: 0 success, 1 error, 2 bad usage.
 */
import {
  addChannel,
  buildChannelsStatus,
  type ChannelAddInput,
  type ChannelAddResult,
  type ChannelStatusRow,
} from '../core/fleet/channels.js';
import { INBOUND_CHANNELS, type InboundChannel } from '../core/fleet/channel-envelope.js';
import { rejectUnknownOptions } from './args.js';

const USAGE = `usage: phm channels status [--json]
       phm channels add telegram <chat-id> [--json]
       phm channels add email <inboxDir> --from <address> [--from <address> ...] [--outbox <dir>] [--processed <dir>] [--json]
       phm channels add <mobile|cli|desktop|page> [--json]`;

function badUsage(message?: string): number {
  if (message) console.error(message);
  console.error(USAGE);
  return 2;
}

function cell(value: string | number | boolean | null | 'unknown'): string {
  if (value === null) return '-';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return String(value);
}

function printStatusTable(rows: ChannelStatusRow[]): void {
  const head = ['channel', 'ready', 'credential', 'paired', 'received', 'pending', 'last seen'];
  const body = rows.map((row) => [
    row.kind,
    cell(row.ready),
    row.credential,
    cell(row.paired),
    cell(row.received),
    cell(row.pendingOutbound),
    cell(row.lastSeenAt),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i]!)).join(' ').trimEnd();
  console.log(line(head));
  for (const cols of body) console.log(line(cols));
  for (const row of rows) {
    if (row.next) console.log(`  ${row.kind}: ${row.next}`);
  }
}

async function cmdStatus(args: string[]): Promise<number> {
  const bad = rejectUnknownOptions(args, { flags: ['--json'] });
  if (bad) return badUsage(bad.message);
  const status = await buildChannelsStatus();
  if (args.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`inbox: ${status.inbox}  (counts from the bounded inbox tail)`);
  printStatusTable(status.channels);
  return 0;
}

async function cmdAdd(args: string[]): Promise<number> {
  const bad = rejectUnknownOptions(args, {
    flags: ['--json'],
    values: ['--from', '--outbox', '--processed'],
  });
  if (bad) return badUsage(bad.message);

  const kind = args[0];
  if (!kind || !(INBOUND_CHANNELS as readonly string[]).includes(kind)) {
    return badUsage(`add needs a channel kind: ${INBOUND_CHANNELS.join(', ')}`);
  }

  let json = false;
  const from: string[] = [];
  const positional: string[] = [];
  const input: ChannelAddInput = { from };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--from') from.push(args[++i] ?? '');
    else if (arg === '--outbox') input.outboxDir = args[++i];
    else if (arg === '--processed') input.processedDir = args[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
    else return badUsage(`unexpected argument: ${arg}`);
  }

  if (kind === 'telegram') input.chatId = positional[0];
  if (kind === 'email') input.inboxDir = positional[0];
  if (positional.length > 1 || (positional.length === 1 && kind !== 'telegram' && kind !== 'email')) {
    return badUsage(`unexpected argument: ${positional[1] ?? positional[0]}`);
  }

  let result: ChannelAddResult;
  try {
    result = await addChannel(kind as InboundChannel, input);
  } catch (error) {
    console.error(`channels add ${kind} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    const wrote = result.path ?? (result.changed.length > 0 ? '~/.ashlr/config.json' : null);
    console.log(wrote ? `${kind}: wrote ${wrote}` : `${kind}: nothing to write`);
    for (const key of result.changed) console.log(`  ${key}`);
    console.log(`  credential: ${result.credential}`);
    if (result.next) console.log(`  next: ${result.next}`);
  } else {
    console.error(result.reason ?? `channels add ${kind} failed`);
    return 2;
  }
  return result.ok ? 0 : 2;
}

export async function cmdChannels(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    console.log(USAGE);
    console.log('');
    console.log('  Config only. Credentials stay in their existing custody and are');
    console.log('  never printed; counts are real numbers or "unknown".');
    return 0;
  }
  if (sub === 'status') return cmdStatus(args.slice(1));
  if (sub === 'add') return cmdAdd(args.slice(1));
  return badUsage(`unknown subcommand: ${sub}`);
}
