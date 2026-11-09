/**
 * `phm comms status --json`, `phm comms thread --json`, and `phm comms send-owner --json`.
 * Status and thread are reads. send-owner writes only to the configured owner.
 */
import { rejectUnknownOptions } from './args.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { liveOwnerTransports } from '../core/comms/owner-live-transport.js';
import {
  readOwnerCommsStatus,
  readOwnerThread,
  sendOwnerReply,
  type OwnerThreadOptions,
} from '../core/comms/owner-thread.js';

const THREAD_USAGE = 'usage: phm comms thread [--limit <1..200>] [--json]';
const SEND_USAGE = 'usage: phm comms send-owner --text <message> [--reply-to <key>] [--idempotency-key <key>] [--json]';

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
  console.log(`owner thread: ${status.threadId} (${status.messages} messages)`);
  console.log(`kill: ${status.kill}  paused: ${status.paused}`);
  for (const adapter of status.adapters) {
    console.log(`  ${adapter.id}: ${adapter.enabled ? 'enabled' : 'disabled'} — ${adapter.reason}`);
  }
  return 0;
}

export async function cmdCommsOwner(args: string[], options = ownerThreadOptions()): Promise<number> {
  const verb = args[0];
  if (verb === 'thread') {
    const bad = rejectUnknownOptions(args.slice(1), { flags: ['--json'], values: ['--limit'] });
    if (bad) { console.error(bad.message); console.error(THREAD_USAGE); return 2; }
    const limitRaw = args[args.indexOf('--limit') + 1];
    const limit = args.includes('--limit') ? Number(limitRaw) : 200;
    if (args.includes('--limit') && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      console.error(THREAD_USAGE);
      return 2;
    }
    const view = readOwnerThread(options, limit);
    const json = args.includes('--json');
    emit(json, view, view.messages.map(message => `${message.seq} ${message.at} ${message.channel} ${message.direction} ${message.text}`).join('\n') || '(empty)');
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
  console.error(THREAD_USAGE);
  console.error(SEND_USAGE);
  return 2;
}
