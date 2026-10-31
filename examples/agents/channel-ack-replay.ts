#!/usr/bin/env -S npx tsx
/** Channel ack replay — a fully local demonstration of durable cross-receiver
 * dedupe and same-channel acknowledgement for Mason's inbound channel boundary.
 *
 * Invocation:
 *   npx tsx examples/agents/channel-ack-replay.ts [--help]
 *
 * The demo creates a private temporary runsDir (automatically removed on every
 * exit path — the live Mason inbox is never touched), then delivers one fixed
 * fake message through a desktop receiver and replays the identical sender and
 * body through a second, freshly constructed Telegram receiver. Because the
 * second receiver has an empty in-memory window, its `duplicate` verdict can
 * only come from the durable receipt store under runsDir — that is the proof of
 * cross-receiver dedupe. Each receiver's `acknowledge` callback records the ack
 * routed back on the channel that received the message. The run prints one JSON
 * line (schema phantom.channel-ack-replay.v1) with the receipt statuses, the
 * acknowledgement channels, and the parsed inbox entry count.
 *
 * Everything is fake and local: a fixed fake sender id, one benign body, no
 * identity flags, no credentials and no network. `verifiedSenderId` stands in
 * for the canonical identity a trusted production adapter must supply after
 * authenticating its transport; the receiver never verifies identity itself.
 * See docs/CHANNEL-DELIVERY-CONTRACT.md.
 *
 * Exit codes: 0 demonstration verified; 1 refusal, mismatch or cleanup failure;
 * 2 usage error; 3 evidence unavailable. Errors are stable JSON objects
 * (`{schema, error, ...}`) and never include raw exception text.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createChannelReceiver,
  type ChannelAck,
  type ChannelMessage,
  type ChannelReceiverOptions,
} from '../../src/core/fleet/channel-envelope.js';
import { readInboxEntries } from '../../src/core/fleet/mason-inbox.js';

export const CHANNEL_ACK_REPLAY_SCHEMA = 'phantom.channel-ack-replay.v1';
const HELP = `Usage: npx tsx examples/agents/channel-ack-replay.ts [--help]

Self-contained local demonstration: a fixed fake message is accepted through a
desktop receiver, then replayed through a fresh Telegram receiver that reports
it as a durable duplicate. Prints one JSON line (schema
phantom.channel-ack-replay.v1) and removes its private temporary runsDir.
Exit codes: 0 verified, 1 failure, 2 usage, 3 evidence unavailable.
`;
const FAKE_SENDER = 'fake-mason';
const FAKE_BODY = 'Fake demonstration message replayed across channels.';
const FAKE_NOW = '2026-10-31T00:13:00.000Z';

export interface ChannelAckReplayDependencies {
  createReceiver?: typeof createChannelReceiver;
  readInbox?: typeof readInboxEntries;
  /** Test hook for a deterministic temporary runsDir. The runner still removes it. */
  makeRunsDir?: () => Promise<string>;
  write?: (text: string) => void;
}

const defaultMakeRunsDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'channel-ack-replay-'));

async function removeRunsDir(runsDir: string): Promise<boolean> {
  try {
    await rm(runsDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Run the demonstration and print one JSON report line. Importing this module performs no work. */
export async function runChannelAckReplay(args: readonly string[], deps: ChannelAckReplayDependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  if (args.length === 1 && args[0] === '--help') {
    write(HELP);
    return 0;
  }

  let runsDir: string | undefined;
  // Every reporting path passes through finish so the temporary runsDir is
  // removed before the JSON line is written, and cleanup failure forces exit 1.
  const finish = async (payload: Record<string, unknown>, code: number): Promise<number> => {
    const dir = runsDir;
    const removed = dir !== undefined ? await removeRunsDir(dir) : false;
    runsDir = undefined;
    write(`${JSON.stringify({ schema: CHANNEL_ACK_REPLAY_SCHEMA, runsDirRemoved: removed, ...payload })}\n`);
    return dir !== undefined && !removed ? 1 : code;
  };
  if (args.length !== 0) return finish({ error: 'This demo takes no arguments. Use --help for usage.' }, 2);

  const createReceiver = deps.createReceiver ?? createChannelReceiver;
  const readInbox = deps.readInbox ?? readInboxEntries;
  try {
    const dir = await (deps.makeRunsDir ?? defaultMakeRunsDir)();
    runsDir = dir;
    // Each receiver gets its own acknowledge callback; the recorded log proves
    // every ack was routed back on the channel that received the message.
    const acknowledgements: ChannelAck[] = [];
    const options = (): ChannelReceiverOptions => ({
      runsDir: dir,
      allowedSenderIds: new Set([FAKE_SENDER]),
      now: () => new Date(FAKE_NOW),
      acknowledge: async (ack) => { acknowledgements.push({ ...ack }); },
    });
    const message = (channel: ChannelMessage['channel']): ChannelMessage =>
      ({ channel, verifiedSenderId: FAKE_SENDER, body: FAKE_BODY });

    // Two receivers in sequence with identical options: the second has no
    // in-memory receipts, so a duplicate verdict proves the durable store.
    const first = await createReceiver(options())(message('desktop'));
    const replay = await createReceiver(options())(message('telegram'));
    if (!first.ok) return finish({ error: 'A receiver refused the fixed fake message.', reason: first.reason }, 1);
    if (!replay.ok) return finish({ error: 'A receiver refused the fixed fake message.', reason: replay.reason }, 1);

    const inbox = await readInbox({ runsDir: dir });
    if (inbox.sourceState !== 'healthy') {
      return finish({ error: 'Demo inbox evidence is unavailable.', sourceState: inbox.sourceState }, 3);
    }
    const entry = inbox.entries[0];
    const sameDedupeKey = first.ack.dedupeKey === replay.ack.dedupeKey;
    const verified =
      first.ack.status === 'accepted' && replay.ack.status === 'duplicate' && sameDedupeKey &&
      acknowledgements.length === 2 &&
      acknowledgements[0]?.channel === 'desktop' && acknowledgements[0]?.status === 'accepted' &&
      acknowledgements[1]?.channel === 'telegram' && acknowledgements[1]?.status === 'duplicate' &&
      inbox.entries.length === 1 && entry?.source === 'desktop' && entry?.text === FAKE_BODY;
    return finish({
      verified,
      runsDir: dir,
      receipts: [first.ack, replay.ack],
      acknowledgements,
      sameDedupeKey,
      inboxEntries: inbox.entries.length,
      entrySource: entry?.source ?? null,
    }, verified ? 0 : 1);
  } catch {
    return finish({ error: 'Unable to complete the demonstration.' }, 1);
  } finally {
    if (runsDir !== undefined) await removeRunsDir(runsDir);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runChannelAckReplay(process.argv.slice(2));
}
