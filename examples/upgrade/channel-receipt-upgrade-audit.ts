#!/usr/bin/env -S npx tsx
/* global process */
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { createChannelReceiver } from '../../src/core/fleet/channel-envelope.js';
import type { readInboxEntries } from '../../src/core/fleet/mason-inbox.js';

const HELP = `Usage: npx tsx examples/upgrade/channel-receipt-upgrade-audit.ts --phantom-dir ABSOLUTE_PACKAGE_ROOT --scratch-dir ABSOLUTE_EMPTY_DIRECTORY

Exercise the installed package's local receiver and inbox reader with fake messages.
Exit codes: 0 verified, 1 mismatch or failure, 2 usage, 3 insufficient evidence.
`;
const SCHEMA = 'phantom.channel-receipt-upgrade-audit.v1';
const SENDER = 'fake-upgrade-audit-sender';
const BODY = 'Fake upgrade audit message; no real transport is involved.';
type Adapters = { createReceiver: typeof createChannelReceiver; readInbox: typeof readInboxEntries };
type Dependencies = { load?: (packageRoot: string) => Promise<Adapters>; write?: (text: string) => void };

async function loadInstalled(packageRoot: string): Promise<Adapters> {
  const receiver: unknown = await import(pathToFileURL(join(packageRoot, 'dist/core/fleet/channel-envelope.js')).href);
  const inbox: unknown = await import(pathToFileURL(join(packageRoot, 'dist/core/fleet/mason-inbox.js')).href);
  if (!receiver || typeof receiver !== 'object' || !('createChannelReceiver' in receiver) ||
      typeof receiver.createChannelReceiver !== 'function' || !inbox || typeof inbox !== 'object' ||
      !('readInboxEntries' in inbox) || typeof inbox.readInboxEntries !== 'function') throw new Error('Missing adapters');
  return { createReceiver: receiver.createChannelReceiver as typeof createChannelReceiver, readInbox: inbox.readInboxEntries as typeof readInboxEntries };
}

/** Exercise an explicitly selected installation and isolated runs directory. */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const error = (message: string, code: number): number => {
    write(`${JSON.stringify({ schema: SCHEMA, error: message })}\n`);
    return code;
  };
  if (args.length === 1 && args[0] === '--help') { write(HELP); return 0; }
  if (args.length !== 4 || args[0] !== '--phantom-dir' || !args[1] || !isAbsolute(args[1]) ||
      args[2] !== '--scratch-dir' || !args[3] || !isAbsolute(args[3])) {
    return error('Expected absolute --phantom-dir and --scratch-dir arguments. Use --help for usage.', 2);
  }
  const packageRoot = resolve(args[1]);
  const runsDir = resolve(args[3]);
  try {
    const stat = await lstat(runsDir);
    if (!stat.isDirectory() || (await readdir(runsDir)).length !== 0) throw new Error('Invalid scratch');
  } catch {
    return error('Scratch directory must be an existing, empty, non-symlink directory.', 2);
  }
  let adapters: Adapters;
  try { adapters = await (deps.load ?? loadInstalled)(packageRoot); } catch {
    return error('Installed receiver or inbox reader is unavailable.', 3);
  }
  try {
    const options = { runsDir, allowedSenderIds: new Set([SENDER]), now: () => new Date('2026-10-31T04:13:00.000Z') };
    const first = await adapters.createReceiver(options)({ channel: 'desktop', verifiedSenderId: SENDER, body: BODY });
    const second = await adapters.createReceiver(options)({ channel: 'mobile', verifiedSenderId: SENDER, body: BODY });
    if (!first.ok || !second.ok) return error('Receiver failed to process a fake message.', 1);
    const acks = [first.ack, second.ack];
    if (acks.some(ack => !ack || typeof ack.dedupeKey !== 'string' || !ack.dedupeKey ||
      (ack.status !== 'accepted' && ack.status !== 'duplicate'))) return error('Receipt evidence is incomplete.', 3);
    const inbox = await adapters.readInbox({ runsDir, limit: 2 });
    if (!inbox || inbox.sourceState !== 'healthy' || !Array.isArray(inbox.entries)) {
      return error('Inbox evidence is unavailable.', 3);
    }
    const accepted = acks.filter(ack => ack.status === 'accepted').length;
    const duplicate = acks.filter(ack => ack.status === 'duplicate').length;
    const sameReceipt = first.ack.dedupeKey === second.ack.dedupeKey;
    const firstSourceRetained = inbox.entries.length === 1 && inbox.entries[0]?.source === 'desktop';
    const verified = first.ack.status === 'accepted' && second.ack.status === 'duplicate' &&
      first.ack.channel === 'desktop' && second.ack.channel === 'mobile' && sameReceipt &&
      firstSourceRetained && inbox.entries[0]?.text === BODY;
    write(`${JSON.stringify({ schema: SCHEMA, verified, accepted, duplicate, sameReceipt,
      inboxEntries: Math.min(inbox.entries.length, 2), firstSourceRetained })}\n`);
    return verified ? 0 : 1;
  } catch {
    return error('Unable to complete the audit.', 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
