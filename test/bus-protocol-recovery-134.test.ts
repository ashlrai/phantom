import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBusEnvelope, validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { claimNextBusWork } from '../src/core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { isClaimableWork, isTopicName, protocolOf, topicMatches } from '../src/core/fleet/bus-protocol.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-protocol-134-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const envelope = (id: string, to: string, body: unknown, changes: Record<string, unknown> = {}) =>
  ({ id, from: 'fake-planner', to, priority: 'P2', ttl: 120_000, body, ...changes });
const task = (id: string, to: string, body: Record<string, unknown> = {}) =>
  envelope(id, to, { protocol: { version: 1, kind: 'task', topic: to }, text: 'fake work', ...body });
const post = (input: unknown) => appendBusInbox(input, { root });
const claim = (to: string, owner = 'fake-worker') =>
  claimNextBusWork({ to, owner, leaseMs: 60_000, root });

it('rejects malformed protocol metadata through real envelope validation and ingest', () => {
  const bad: Array<[string, unknown]> = [
    ['non-object', { protocol: 'task' }],
    ['array', { protocol: [] }],
    ['unknown field', { protocol: { version: 1, kind: 'task', extra: 1 } }],
    ['wrong version', { protocol: { version: 2, kind: 'task' } }],
    ['legacy kind', { protocol: { version: 1, kind: 'work' } }],
    ['topic mismatch', { protocol: { version: 1, kind: 'task', topic: 'fleet.other' } }],
    ['bare namespace topic', { protocol: { version: 1, kind: 'task', topic: 'deploy' } }],
    ['spaced payload ref', { protocol: { version: 1, kind: 'task', payload_ref: 'a b' } }],
    ['oversized payload ref', { protocol: { version: 1, kind: 'task', payload_ref: 'x'.repeat(257) } }],
  ];
  for (const [label, body] of bad) {
    const input = envelope(`fake-bad-${label.replaceAll(' ', '-')}`, 'agent-a', body);
    const checked = validateBusEnvelope(input);
    expect(checked.ok, label).toBe(false);
    if (!checked.ok) expect(checked.issues[0]).toMatchObject({ code: 'invalid-field', path: '$.body.protocol' });
    expect(parseBusEnvelope(JSON.stringify(input)).ok, label).toBe(false);
    expect(post(input).status, label).toBe('invalid');
  }
  // Nothing was appended: the inbox store was never created.
  expect(listBusInboxAfter(0, 100, { root })).toMatchObject({ status: 'ok', messages: [] });
});

it('preserves legacy envelopes and accepts a valid protocol task with an inert bounded payload ref', () => {
  expect(post(envelope('fake-legacy', 'agent-a', { kind: 'work', text: 'x' })).status).toBe('posted');
  expect(post(envelope('fake-null', 'agent-a', null)).status).toBe('posted');
  expect(post(envelope('fake-chat', 'agent-a', 'fake chat')).status).toBe('posted');
  const valid = envelope('fake-task', 'fleet.deploy', {
    protocol: { version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'artifact:fake/run-1/log.txt' },
    text: 'fake work',
  });
  expect(post(valid).status).toBe('posted');
  const page = listBusInboxAfter(0, 100, { root });
  expect(page.status).toBe('ok');
  if (page.status !== 'ok') return;
  const stored = page.messages.find(row => row.envelope.id === 'fake-task');
  // The payload ref stays opaque routing data inside `protocol`: the bus stores
  // and returns the body verbatim and never fetches or expands the reference.
  expect(protocolOf(stored?.envelope.body)).toEqual({
    version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'artifact:fake/run-1/log.txt',
  });
  expect(stored?.envelope.body).toMatchObject({ text: 'fake work' });
});

it('gives a protocol task to exactly one claimant while result, status and question stay unclaimable', () => {
  expect(post(task('fake-task', 'fleet.deploy')).status).toBe('posted');
  expect(post(envelope('fake-result', 'fleet.deploy',
    { protocol: { version: 1, kind: 'result', topic: 'fleet.deploy', payload_ref: 'artifact:fake/out' } })).status).toBe('posted');
  expect(post(envelope('fake-status', 'fleet.deploy',
    { protocol: { version: 1, kind: 'status' } })).status).toBe('posted');
  expect(post(envelope('fake-question', 'fleet.deploy',
    { protocol: { version: 1, kind: 'question' } })).status).toBe('posted');

  const first = claim('fleet.deploy', 'fake-a');
  expect(first.status).toBe('acquired');
  if (first.status !== 'acquired' || !('token' in first)) throw new Error('expected a claim');
  expect(first.receipt.envelope.id).toBe('fake-task');
  // Exactly once: a second claimant finds the queue empty of claimable work.
  expect(claim('fleet.deploy', 'fake-b')).toEqual({ status: 'empty' });
  // Result/status/question bodies were never claim candidates and remain in the inbox.
  const page = listBusInboxAfter(0, 100, { root });
  expect(page.status).toBe('ok');
  if (page.status === 'ok') expect(page.messages.map(row => row.envelope.id).sort())
    .toEqual(['fake-question', 'fake-result', 'fake-status', 'fake-task']);
  // Labels confer no authority: completing still requires the fencing token.
  expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-task', token: 'a'.repeat(64), root }))
    .toMatchObject({ status: 'mismatched-token' });
  expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-task', token: first.token, root }))
    .toMatchObject({ status: 'completed' });
});

it('keeps the legacy kind=work convention claimable next to protocol tasks', () => {
  expect(post(envelope('fake-legacy-work', 'agent-a', { kind: 'work' })).status).toBe('posted');
  expect(post(envelope('fake-note', 'agent-a', { kind: 'note' })).status).toBe('posted');
  const claimed = claim('agent-a');
  expect(claimed.status).toBe('acquired');
  if (claimed.status === 'acquired' && 'receipt' in claimed) {
    expect(claimed.receipt.envelope.id).toBe('fake-legacy-work');
  }
  expect(claim('agent-a')).toEqual({ status: 'empty' });
});

it('requires the protocol topic to equal the destination so topics cannot retarget', () => {
  // `to` is a routing label; a task naming another topic is refused at ingest.
  expect(post(envelope('fake-mismatch', 'agent-a',
    { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } })).status).toBe('invalid');
  // A protocol-less body addressed anywhere stays claimable only by exact `to` match.
  expect(post(envelope('fake-plain', 'agent-b', { kind: 'work' })).status).toBe('posted');
  expect(claim('agent-a')).toEqual({ status: 'empty' });
  const taken = claim('agent-b');
  expect(taken.status).toBe('acquired');
});

it('keeps topic helpers segment-safe: prefixes never cross namespace boundaries', () => {
  expect(isTopicName('fleet.deploy')).toBe(true);
  expect(isTopicName('fleet')).toBe(false);
  expect(topicMatches('fleet.*', 'fleet.deploy')).toBe(true);
  expect(topicMatches('fleet.*', 'fleetx.deploy')).toBe(false);
  expect(isClaimableWork({ protocol: { version: 1, kind: 'task' } })).toBe(true);
  expect(isClaimableWork({ kind: 'work' })).toBe(true);
  expect(isClaimableWork({ protocol: { version: 1, kind: 'result' } })).toBe(false);
});
