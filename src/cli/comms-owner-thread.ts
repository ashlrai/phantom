/**
 * `phm comms status --json`, `phm comms thread --json`, and `phm comms send-owner --json`.
 * Status and thread are reads. send-owner writes only to the configured owner.
 */
import { rejectUnknownOptions } from './args.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { liveOwnerTransports } from '../core/comms/owner-live-transport.js';
import { OWNER_CHANNELS, isOwnerChannel } from '../core/comms/leader-mailbox.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import {
  OWNER_THREAD_CONTAINS_MAX,
  isOwnerThreadKey,
  readOwnerCommsStatus,
  readOwnerThread,
  sendOwnerHello,
  sendOwnerReply,
  type OwnerThreadOptions,
  type OwnerThreadReadFilter,
} from '../core/comms/owner-thread.js';

const THREAD_USAGE = 'usage: phm comms thread [--limit <1..200>] [--channel <desktop|telegram|email|imessage|slack>] [--direction <inbound|outbound>] [--since <15m|2h|1d|ISO|epoch-ms>] [--before-at <15m|2h|1d|ISO|epoch-ms>] [--contains <text>] [--reply-to <key>] [--awaiting] [--json]';
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

/**
 * Parse the shared `--channel`/`--direction`/`--since`/`--before-at`/`--contains`/`--reply-to` slice
 * flags into the `OwnerThreadReadFilter` `phm comms thread` and
 * `phm fleet owner-history` both apply, so the live read and the archive
 * read can never disagree about what a flag means. Returns the filter to
 * pass through — absent when no flag was given — or `error`, the one-line
 * reason the args are invalid for the caller to print beside its own
 * usage. A repeated flag resolves to its first occurrence, exactly as the
 * inline parses always did; each caller keeps its own unknown-option and
 * duplicate-flag checks.
 */
export function parseOwnerThreadFilterArgs(args: string[]): { filter?: OwnerThreadReadFilter; error?: string } {
  const filter: OwnerThreadReadFilter = {};
  if (args.includes('--channel')) {
    const raw = args[args.indexOf('--channel') + 1];
    if (raw === undefined || !isOwnerChannel(raw)) {
      return { error: `--channel takes one of ${OWNER_CHANNELS.join(', ')}.` };
    }
    filter.channel = raw;
  }
  if (args.includes('--direction')) {
    const raw = args[args.indexOf('--direction') + 1];
    if (raw !== 'inbound' && raw !== 'outbound') {
      return { error: '--direction takes inbound or outbound.' };
    }
    filter.direction = raw;
  }
  if (args.includes('--since')) {
    const raw = args[args.indexOf('--since') + 1];
    const parsed = raw === undefined ? null : parseSince(raw);
    if (parsed === null) {
      return { error: '--since takes 15m, 2h, 1d, epoch ms or an ISO time.' };
    }
    filter.since = parsed;
  }
  if (args.includes('--before-at')) {
    const raw = args[args.indexOf('--before-at') + 1];
    const parsed = raw === undefined ? null : parseSince(raw);
    if (parsed === null) {
      return { error: '--before-at takes 15m, 2h, 1d, epoch ms or an ISO time.' };
    }
    filter.beforeAt = parsed;
  }
  if (args.includes('--contains')) {
    const raw = args[args.indexOf('--contains') + 1];
    // Free text, not a label: printable content of any kind is fine,
    // bounded like every other comms read's --contains; a flag-looking
    // or blank value is a missing needle, not a search.
    if (raw === undefined || raw.startsWith('--') || raw.trim() === '' || raw.length > OWNER_THREAD_CONTAINS_MAX) {
      return { error: `--contains takes a non-empty search text of at most ${OWNER_THREAD_CONTAINS_MAX} characters.` };
    }
    filter.contains = raw;
  }
  if (args.includes('--reply-to')) {
    const raw = args[args.indexOf('--reply-to') + 1];
    // The exchange key is an idempotency key, not free text: a flag-looking
    // or out-of-grammar value is a missing key, not an exchange nothing owns.
    if (raw === undefined || raw.startsWith('--') || !isOwnerThreadKey(raw)) {
      return { error: '--reply-to takes an owner-thread message key.' };
    }
    filter.replyTo = raw;
  }
  return { ...(Object.keys(filter).length === 0 ? {} : { filter }) };
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
    const bad = rejectUnknownOptions(args.slice(1), { flags: ['--json', '--awaiting'], values: ['--limit', '--channel', '--direction', '--since', '--before-at', '--contains', '--reply-to'] });
    if (bad) { console.error(bad.message); console.error(THREAD_USAGE); return 2; }
    const limitRaw = args[args.indexOf('--limit') + 1];
    const limit = args.includes('--limit') ? Number(limitRaw) : 200;
    if (args.includes('--limit') && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      console.error(THREAD_USAGE);
      return 2;
    }
    const parsed = parseOwnerThreadFilterArgs(args);
    if (parsed.error !== undefined) {
      console.error(parsed.error);
      console.error(THREAD_USAGE);
      return 2;
    }
    // --awaiting is a live-window slice the archive read never takes, so it
    // stays out of the shared filter parser `phm fleet owner-history` runs.
    const filter = args.includes('--awaiting')
      ? { ...(parsed.filter ?? {}), awaiting: true as const }
      : parsed.filter;
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
