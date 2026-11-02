#!/usr/bin/env -S npx tsx
/**
 * Local-only example: npx tsx examples/channel-context-roundtrip.ts --workspace /tmp/YOUR_TEMP_DIR
 * Add --identity other to exercise rejection. The two identity choices are
 * fixed simulation fixtures, not authentication; a real adapter must verify
 * transport evidence before providing a canonical sender ID to the receiver.
 * The workspace must already exist beneath the OS temporary directory.
 */
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChannelReceiver, type ChannelAck } from '../src/core/fleet/channel-envelope.js';
import { createLocalChannelDedupeStore } from '../src/core/fleet/channel-dedupe-store.js';
import { listNodeBusNotices } from '../src/core/fleet/node-bus-notices.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';

const SENDER = 'example-verified-mason';
const BODY = 'Fake Mason interjection: coordinate the next graph node.';
const BUDGET = 1024;

/** Only the acknowledgement transport is replaceable; all stores are real. */
export async function main(args: readonly string[], transport?: (ack: ChannelAck) => Promise<void>) {
  if ((args.length !== 2 && args.length !== 4) || args[0] !== '--workspace' ||
      !args[1] || !isAbsolute(args[1]) ||
      (args.length === 4 && (args[2] !== '--identity' || !['mason', 'other'].includes(args[3] ?? '')))) {
    throw new Error('Usage: --workspace ABSOLUTE_TEMP_DIR [--identity mason|other]');
  }
  const workspace = realpathSync(args[1]);
  const withinTemp = relative(realpathSync(tmpdir()), workspace);
  if (!statSync(workspace).isDirectory() || !withinTemp || withinTemp === '..' ||
      withinTemp.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(withinTemp)) {
    throw new Error('Workspace must be an existing directory beneath the OS temporary directory.');
  }
  const runsDir = join(workspace, 'runs');
  const busRoot = join(workspace, 'bus');
  const acknowledgements: ChannelAck[] = [];
  // Simulates the result of a verified transport session. No claimed sender
  // from message content or command-line input is treated as authentication.
  const verifiedSenderId = args[3] === 'other' ? 'example-verified-other' : SENDER;
  const message = { channel: 'desktop' as const, verifiedSenderId, body: BODY };
  const receiver = () => createChannelReceiver({
    allowedSenderIds: new Set([SENDER]), runsDir, busRoot,
    receiptStore: createLocalChannelDedupeStore(runsDir),
    acknowledge: async ack => {
      acknowledgements.push(ack);
      await transport?.(ack);
    },
  });
  const first = await receiver()(message);
  if (!first.ok) return { first, acknowledgements };
  if (first.ack.status === 'accepted' && first.publishState !== 'published') {
    throw new Error(`Inbox accepted, but bus publication ${first.publishState}.`);
  }
  // Recreate the receiver and store to demonstrate the durable receipt window.
  const replay = await receiver()(message);
  if (!replay.ok || replay.ack.status !== 'duplicate') throw new Error('Replay was not deduplicated.');
  const busId = `mason-${first.envelope.channel}-${first.envelope.dedupeKey.slice(0, 16)}`;
  const notices = listNodeBusNotices('leaders', 0, { options: { root: busRoot } })
    .filter(notice => notice.id === busId);
  if (notices.length !== 1) throw new Error('The durable bus envelope was not readable.');
  const pack = buildNodeContextPack({
    node: { jobId: 'example-node', upstreamJobIds: [], busAddress: 'leaders' },
    tasks: [], outputs: [], notices, byteBudget: BUDGET,
  });
  if (!pack) throw new Error('The cited notice did not fit in the context budget.');
  return { first, replay, acknowledgements, pack, byteBudget: BUDGET };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Example failed.'}\n`);
    process.exitCode = 1;
  }
}
