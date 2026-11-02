import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import { buildChannelBusEnvelope } from '../src/core/fleet/channel-bus-publish.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

const sender = 'fake-mason';
const roots: string[] = [];
const dir = () => { const root = mkdtempSync(join(tmpdir(), 'channel-bus-31-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function busMessages(root: string) {
  const page = listBusInboxAfter(0, 50, { root });
  if (page.status !== 'ok') throw new Error(`bus read failed: ${page.status}`);
  return page.messages;
}

describe('channel receiver agent-bus publish', () => {
  it('publishes one accepted message as a mason to leaders interjection', async () => {
    const runsDir = dir(), busRoot = dir();
    const receive = createChannelReceiver({ allowedSenderIds: new Set([sender]), runsDir, busRoot });
    const result = await receive({ channel: 'cli', verifiedSenderId: sender, body: 'interject now' });
    expect(result.ok && result.ack.status).toBe('accepted');
    expect(result.ok && result.publishState).toBe('published');
    const messages = busMessages(busRoot);
    expect(messages).toHaveLength(1);
    const envelope = messages[0]!.envelope;
    expect(envelope.from).toBe('mason');
    expect(envelope.to).toBe('leaders');
    expect(envelope.priority).toBe('P0');
    expect(envelope.id).toMatch(/^mason-cli-[a-f0-9]{16}$/);
    expect(envelope.body).toMatchObject({
      kind: 'interjection', channel: 'cli', text: 'interject now',
      receivedAt: result.ok ? result.envelope.receivedAt : '',
      dedupeKey: result.ok ? result.envelope.dedupeKey : '',
    });
  });

  it('does not republish a deduplicated receipt', async () => {
    const runsDir = dir(), busRoot = dir();
    const receive = createChannelReceiver({ allowedSenderIds: new Set([sender]), runsDir, busRoot });
    const message = { channel: 'email' as const, verifiedSenderId: sender, body: 'same body' };
    expect((await receive(message)).ok).toBe(true);
    const second = await receive({ ...message, channel: 'telegram' });
    expect(second.ok && second.ack.status).toBe('duplicate');
    expect(busMessages(busRoot)).toHaveLength(1);
  });

  it('still accepts the receipt when the bus store is unavailable', async () => {
    const runsDir = dir();
    const blocker = join(dir(), 'not-a-directory');
    writeFileSync(blocker, 'x');
    const receive = createChannelReceiver({ allowedSenderIds: new Set([sender]), runsDir, busRoot: blocker });
    const result = await receive({ channel: 'desktop', verifiedSenderId: sender, body: 'still lands' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.publishState).toBe('failed');
    expect((await readInboxEntries({ runsDir })).entries).toHaveLength(1);
  });

  it('publish: null leaves the bus untouched and reports skipped', async () => {
    const runsDir = dir(), busRoot = dir();
    const receive = createChannelReceiver({ allowedSenderIds: new Set([sender]), runsDir, busRoot, publish: null });
    const result = await receive({ channel: 'mobile', verifiedSenderId: sender, body: 'quiet' });
    expect(result.ok && result.ack.status).toBe('accepted');
    expect(result.ok && result.publishState).toBe('skipped');
    expect(existsSync(join(busRoot, 'bus-inbox'))).toBe(false);
  });

  it('buildChannelBusEnvelope emits a valid wire envelope and refuses oversize bodies', () => {
    const built = buildChannelBusEnvelope({
      channel: 'cli', verifiedSenderId: sender, receivedAt: new Date(1_760_000_000_000).toISOString(),
      body: 'hello leaders', dedupeKey: 'a'.repeat(64),
    });
    expect(built).not.toBeNull();
    expect(validateBusEnvelope(built).ok).toBe(true);
    expect(built!.id).toBe(`mason-cli-${'a'.repeat(16)}`);
    expect(built!.ttl).toBe(7 * 24 * 60 * 60 * 1000);
    expect(buildChannelBusEnvelope({
      channel: 'cli', verifiedSenderId: sender, receivedAt: new Date(1_760_000_000_000).toISOString(),
      body: 'x'.repeat(70 * 1024), dedupeKey: 'b'.repeat(64),
    })).toBeNull();
  });
});
