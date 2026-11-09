import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeTeammateFindings } from '../src/core/comms/imessage-findings-bridge.js';
import { recordTeammateText, senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { CHANNEL_BUS_TTL_MS } from '../src/core/fleet/channel-bus-publish.js';

const root = mkdtempSync(join(tmpdir(), 'findings-preservation-'));
const runsDir = join(root, 'runs');
const busRoot = join(root, 'bus');
const handle = 'synthetic-teammate@example.test';
const body = 'Synthetic finding for preservation';
const now = new Date('2026-11-09T12:00:00Z');
const bridge = () => bridgeTeammateFindings({ runsDir, busRoot, now: () => now });

afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses expired records and keeps replayed teammate findings private, idempotent notes', () => {
  expect(recordTeammateText({ rowid: 1, handle, text: body }, runsDir,
    new Date(now.getTime() - CHANNEL_BUS_TTL_MS - 1))).toBe(true);
  expect(recordTeammateText({ rowid: 2, handle, text: body }, runsDir, now)).toBe(true);
  const first = bridge();
  expect(first).toMatchObject({ examined: 2, refused: 1, posted: 1, lastRowid: 2 });
  expect(JSON.stringify(first)).not.toContain(handle);
  expect(JSON.stringify(first)).not.toContain(body);
  expect(bridge()).toMatchObject({ examined: 0, posted: 0, lastRowid: 2 });

  // Simulate a lost watermark: the real store still deduplicates the same ID.
  writeFileSync(join(runsDir, 'imessage', 'findings-bridge.json'),
    JSON.stringify({ v: 1, lastRowid: 0 }), { mode: 0o600 });
  const replay = bridge();
  expect(replay).toMatchObject({ refused: 1, duplicate: 1, posted: 0, lastRowid: 2 });
  expect(JSON.stringify(replay)).not.toContain(handle);
  expect(JSON.stringify(replay)).not.toContain(body);
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  expect(page.status).toBe('ok');
  if (page.status !== 'ok') throw new Error('Synthetic bus unavailable');
  expect(page.messages).toHaveLength(1);
  const envelope = page.messages[0]!.envelope;
  expect(senderIdFor(handle)).toMatch(/^imessage:[a-f0-9]{16}$/);
  expect(envelope).toMatchObject({
    id: 'imessage-teammate-2', from: senderIdFor(handle), ttl: CHANNEL_BUS_TTL_MS,
    sender: { agent_id: senderIdFor(handle) },
    body: { kind: 'note', text: body }, external: false,
  });
  expect(envelope.body).not.toHaveProperty('argv');
  expect(JSON.stringify(envelope)).not.toContain(handle);
});
