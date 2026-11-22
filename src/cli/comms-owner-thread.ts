/**
 * `phm comms status --json`, `phm comms thread --json`, and `phm comms send-owner --json`.
 * Status and thread are reads. send-owner writes only to the configured owner.
 */
import { rejectUnknownOptions } from './args.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { liveOwnerTransports } from '../core/comms/owner-live-transport.js';
import { OWNER_CHANNELS, isOwnerChannel, type OwnerChannel } from '../core/comms/leader-mailbox.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import {
  OWNER_THREAD_CONTAINS_MAX,
  readOwnerCommsStatus,
  readOwnerThread,
  sendOwnerHello,
  sendOwnerReply,
  type OwnerThreadOptions,
} from '../core/comms/owner-thread.js';

const THREAD_USAGE = 'usage: phm comms thread [--limit <1..200>] [--channel <desktop|telegram|email|imessage|slack>] [--since <15m|2h|1d|ISO|epoch-ms>] [--contains <text>] [--json]';
const SEND_USAGE = 'usage: phm comms send-owner --text <message> [--reply-to <key>] [--idempotency-key <key>] [--json]';

const HELLO_USAGE = 'usage: phm comms owner hello [--json]';

function runsDir(): string {
  return fixedOwnerRunsDir();
}

function configDir(): string {
  return fixedOwnerConfigDir();
}

export function ownerThreadOptions(transports: OwnerThreadOptions['transports'] = liveOwnerTransports(loadOwnerThreadSettings(configDir()), runsDir())): OwnerThreadOptions {
  return {
    runsDir: runsDir(),
    settings: loadOwnerThreadSettings(configDir()),
    transports,
  };
}

function emit(json: boolean, value: unknown, text: string): void {
  console.log(json ? JSON.stringify(value) : text);
}

export async function cmdCommsOwnerStatus(json: boolean, options = ownerThreadOptions()): Promise<number> {
  const status = readOwnerCommsStatus(options);
  if (json) {
    console.log(JSON.stringify(status));
    return 0;
  }
  console.log(`owner thread: ${status.threadId} (messages: ${status.messages ?? 'unknown'})`);
  console.log(`kill: ${status.kill}  paused: ${status.paused}`);
  console.log(`awaiting reply: ${status.awaitingReply ?? 'unknown'}`);
  console.log(`undelivered replies: ${status.undeliveredReplies ?? 'unknown'}`);
  for (const adapter of status.adapters) {
    console.log(`  ${adapter.id}: ${adapter.enabled ? 'enabled' : 'disabled'} — ${adapter.reason}`);
    if (adapter.nextStep !== null) console.log(`    next: ${adapter.nextStep}`);
  }
  return 0;
}

export async function cmdCommsOwner(args: string[], options = ownerThreadOptions()): Promise<number> {
  const verb = args[0];
  if (verb === 'thread') {
    const bad = rejectUnknownOptions(args.slice(1), { flags: ['--json'], values: ['--limit', '--channel', '--since', '--contains'] });
    if (bad) { console.error(bad.message); console.error(THREAD_USAGE); return 2; }
    const limitRaw = args[args.indexOf('--limit') + 1];
    const limit = args.includes('--limit') ? Number(limitRaw) : 200;
    if (args.includes('--limit') && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      console.error(THREAD_USAGE);
      return 2;
    }
    let channel: OwnerChannel | undefined;
    if (args.includes('--channel')) {
      const raw = args[args.indexOf('--channel') + 1];
      if (raw === undefined || !isOwnerChannel(raw)) {
        console.error(`--channel takes one of ${OWNER_CHANNELS.join(', ')}.`);
        console.error(THREAD_USAGE);
        return 2;
      }
      channel = raw;
    }
    let since: number | undefined;
    if (args.includes('--since')) {
      const raw = args[args.indexOf('--since') + 1];
      const parsed = raw === undefined ? null : parseSince(raw);
      if (parsed === null) {
        console.error('--since takes 15m, 2h, 1d, epoch ms or an ISO time.');
        console.error(THREAD_USAGE);
        return 2;
      }
      since = parsed;
    }
    let contains: string | undefined;
    if (args.includes('--contains')) {
      const raw = args[args.indexOf('--contains') + 1];
      // Free text, not a label: printable content of any kind is fine,
      // bounded like every other comms read's --contains; a flag-looking
      // or blank value is a missing needle, not a search.
      if (raw === undefined || raw.startsWith('--') || raw.trim() === '' || raw.length > OWNER_THREAD_CONTAINS_MAX) {
        console.error(`--contains takes a non-empty search text of at most ${OWNER_THREAD_CONTAINS_MAX} characters.`);
        console.error(THREAD_USAGE);
        return 2;
      }
      contains = raw;
    }
    const filter = channel !== undefined || since !== undefined || contains !== undefined
      ? { ...(channel !== undefined ? { channel } : {}), ...(since !== undefined ? { since } : {}), ...(contains !== undefined ? { contains } : {}) }
      : undefined;
    const view = readOwnerThread(options, limit, filter);
    const json = args.includes('--json');
    const awaiting = new Set(view.awaitingReply ?? []);
    emit(json, view, view.messages.map(message => {
      const line = `${message.seq} ${message.at} ${message.channel} ${message.direction} ${message.text}`;
      if (message.direction === 'inbound') return awaiting.has(message.id) ? `${line} [awaiting reply]` : line;
      const perChannel = view.receipts[message.id];
      if (!perChannel) return line;
      const states = Object.entries(perChannel).sort(([a], [b]) => a.localeCompare(b))
        .map(([channel, receipt]) => `${channel}:${receipt.state}`);
      return states.length ? `${line} [${states.join(' ')}]` : line;
    }).join('\n') || '(empty)');
    return 'unavailable' in view ? 1 : 0;
  }
  if (verb === 'send-owner') {
    const bad = rejectUnknownOptions(args.slice(1), { flags: ['--json'], values: ['--text', '--reply-to', '--idempotency-key'] });
    if (bad) { console.error(bad.message); console.error(SEND_USAGE); return 2; }
    const text = args[args.indexOf('--text') + 1];
    if (!args.includes('--text') || !text || text.startsWith('--')) {
      console.error(SEND_USAGE);
      return 2;
    }
    const replyTo = args.includes('--reply-to') ? args[args.indexOf('--reply-to') + 1] : undefined;
    const idempotencyKey = args.includes('--idempotency-key') ? args[args.indexOf('--idempotency-key') + 1] : undefined;
    const result = await sendOwnerReply({ text, ...(replyTo ? { replyTo } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) }, options);
    const json = args.includes('--json');
    emit(json, result, `${result.status}${result.reason ? `: ${result.reason}` : ''}`);
    return result.status === 'sent' || result.status === 'duplicate' || result.status === 'partial' ? 0 : 1;
  }
  if (verb === 'hello') {
    const bad = rejectUnknownOptions(args.slice(1), { flags: ['--json'] });
    if (bad) { console.error(bad.message); console.error(HELLO_USAGE); return 2; }
    const result = await sendOwnerHello(options);
    const lines = result.deliveries.map(row => `${row.channel}: ${
      row.status === 'sent' ? 'sent' : row.status === 'duplicate' ? 'already sent' : `skipped (${row.reason})`}`);
    emit(args.includes('--json'), result, lines.join('\n') || result.status);
    return result.status === 'sent' || result.status === 'duplicate' || result.status === 'partial' ? 0 : 1;
  }
  console.error(THREAD_USAGE);
  console.error(SEND_USAGE);
  console.error(HELLO_USAGE);
  return 2;
}
