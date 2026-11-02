import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_ACK_REPLAY_SCHEMA,
  runChannelAckReplay,
  type ChannelAckReplayDependencies,
} from '../examples/agents/channel-ack-replay.js';
import { createChannelReceiver, type ChannelReceiverOptions } from '../src/core/fleet/channel-envelope.js';
import { readInboxEntries, type InboxEntry } from '../src/core/fleet/mason-inbox.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function demo(args: string[] = [], deps: ChannelAckReplayDependencies = {}) {
  const out: string[] = [];
  const code = await runChannelAckReplay(args, { ...deps, write: (text) => { out.push(text); } });
  return { code, text: out.join(''), json: () => JSON.parse(out.join('')) as Record<string, unknown> };
}

describe('channel ack replay demo (31za)', () => {
  it('accepts the first receipt, dedupes the replay on a fresh receiver, acks each receiving channel, and keeps one entry', async () => {
    let receiptFileExisted = false;
    let persisted: InboxEntry[] = [];
    const createReceiver = vi.fn((options: ChannelReceiverOptions) => createChannelReceiver(options));
    const readInbox: typeof readInboxEntries = async (opts) => {
      receiptFileExisted = existsSync(join(String(opts?.runsDir), 'channel-receipts', 'receipts.json'));
      const result = await readInboxEntries(opts);
      persisted = result.entries;
      return result;
    };
    const { code, json } = await demo([], { createReceiver, readInbox });
    const report = json();
    expect(code, JSON.stringify(report)).toBe(0);
    expect(report).toMatchObject({
      schema: CHANNEL_ACK_REPLAY_SCHEMA, verified: true, runsDirRemoved: true,
      sameDedupeKey: true, inboxEntries: 1, entrySource: 'desktop',
    });
    const receipts = report.receipts as { channel: string; status: string; dedupeKey: string }[];
    expect(receipts.map(({ channel, status }) => [channel, status])).toEqual([
      ['desktop', 'accepted'], ['telegram', 'duplicate'],
    ]);
    expect(receipts[0]?.dedupeKey).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts[0]?.dedupeKey).toBe(receipts[1]?.dedupeKey);
    expect(report.acknowledgements).toEqual(receipts);
    const runsDir = report.runsDir as string;
    expect(runsDir.startsWith(`${tmpdir()}/`)).toBe(true);
    expect(existsSync(runsDir)).toBe(false);
    expect(createReceiver).toHaveBeenCalledTimes(2);
    expect(createReceiver.mock.calls[0]?.[0].allowedSenderIds).toEqual(createReceiver.mock.calls[1]?.[0].allowedSenderIds);
    expect(receiptFileExisted).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.text).toBe('Fake demonstration message replayed across channels.');
  });

  it('runs as a script and verifies end to end without touching the live inbox', () => {
    const home = mkdtempSync(join(tmpdir(), 'ack-replay-home-'));
    const foreign = mkdtempSync(join(tmpdir(), 'ack-replay-tmp-'));
    roots.push(home, foreign);
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('examples/agents/channel-ack-replay.ts')],
      { encoding: 'utf8', env: { HOME: home, TMPDIR: foreign, PATH: process.env.PATH } },
    );
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      schema: CHANNEL_ACK_REPLAY_SCHEMA, verified: true,
      sameDedupeKey: true, inboxEntries: 1, runsDirRemoved: true,
    });
    const runsDir = report.runsDir as string;
    expect(runsDir.startsWith(`${foreign}/`)).toBe(true);
    expect(runsDir.includes(home)).toBe(false);
    expect(existsSync(runsDir)).toBe(false);
    // tsx may keep its own cache directory; only demo leftovers are checked.
    expect(readdirSync(foreign).filter((name) => name.startsWith('channel-ack-replay-'))).toEqual([]);
  }, 30_000);

  it('removes the temporary runsDir and reports the stable refusal reason when the replay is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ack-replay-refused-'));
    roots.push(root);
    const runsDir = join(root, 'runs');
    let receiver = 0;
    const createReceiver: typeof createChannelReceiver = (options) => {
      receiver += 1;
      return receiver === 1 ? createChannelReceiver(options) : async () => ({ ok: false, reason: 'write-failed' });
    };
    const { code, json } = await demo([], {
      createReceiver,
      makeRunsDir: async () => { await mkdir(runsDir); return runsDir; },
    });
    expect(code).toBe(1);
    expect(json()).toEqual({
      schema: CHANNEL_ACK_REPLAY_SCHEMA, runsDirRemoved: true,
      error: 'A receiver refused the fixed fake message.', reason: 'write-failed',
    });
    expect(existsSync(runsDir)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('removes the temporary runsDir and hides raw exception text when a receiver throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ack-replay-throw-'));
    roots.push(root);
    const runsDir = join(root, 'runs');
    const createReceiver: typeof createChannelReceiver = () => { throw new Error('fake private path'); };
    const { code, text, json } = await demo([], {
      createReceiver,
      makeRunsDir: async () => { await mkdir(runsDir); return runsDir; },
    });
    expect(code).toBe(1);
    expect(json()).toEqual({
      schema: CHANNEL_ACK_REPLAY_SCHEMA, runsDirRemoved: true,
      error: 'Unable to complete the demonstration.',
    });
    expect(text).not.toContain('fake private path');
    expect(existsSync(runsDir)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('removes the temporary runsDir and exits 3 when inbox evidence is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ack-replay-evidence-'));
    roots.push(root);
    const runsDir = join(root, 'runs');
    const readInbox: typeof readInboxEntries = async () => ({ sourceState: 'missing', entries: [] });
    const { code, json } = await demo([], {
      readInbox,
      makeRunsDir: async () => { await mkdir(runsDir); return runsDir; },
    });
    expect(code).toBe(3);
    expect(json()).toEqual({
      schema: CHANNEL_ACK_REPLAY_SCHEMA, runsDirRemoved: true,
      error: 'Demo inbox evidence is unavailable.', sourceState: 'missing',
    });
    expect(existsSync(runsDir)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('prints help and rejects arguments without creating a runsDir', async () => {
    const makeRunsDir = vi.fn(async () => join(tmpdir(), 'ack-replay-unused-'));
    const help = await demo(['--help'], { makeRunsDir });
    expect(help.code).toBe(0);
    expect(help.text).toContain('npx tsx examples/agents/channel-ack-replay.ts');
    const bad = await demo(['--sender', 'fake'], { makeRunsDir });
    expect(bad.code).toBe(2);
    expect(bad.json()).toEqual({
      schema: CHANNEL_ACK_REPLAY_SCHEMA, runsDirRemoved: false,
      error: 'This demo takes no arguments. Use --help for usage.',
    });
    expect(makeRunsDir).not.toHaveBeenCalled();
  });
});
