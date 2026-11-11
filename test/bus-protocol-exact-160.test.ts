import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBusEnvelope, validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { claimNextBusWork } from '../src/core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { isClaimableWork, protocolOf } from '../src/core/fleet/bus-protocol.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-protocol-160-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const envelope = (id: string, to: string, body: unknown, changes: Record<string, unknown> = {}) =>
  ({ id, from: 'fake-submitter', to, priority: 'P2', ttl: 120_000, body, ...changes });
const post = (input: unknown) => appendBusInbox(input, { root });
const claim = (to: string, owner = 'fake-agent') =>
  claimNextBusWork({ to, owner, leaseMs: 60_000, root });
const page = () => listBusInboxAfter(0, 100, { root });

it('refuses malformed protocol metadata before anything reaches the inbox', () => {
  const bad: Array<[string, unknown]> = [
    ['scalar', { protocol: 1 }],
    ['array', { protocol: ['task'] }],
    ['null', { protocol: null }],
    ['extra field', { protocol: { version: 1, kind: 'task', priority: 'P0' } }],
    ['bad version', { protocol: { version: '1', kind: 'task' } }],
    ['unknown kind', { protocol: { version: 1, kind: 'command' } }],
    ['legacy work kind', { protocol: { version: 1, kind: 'work' } }],
    ['invalid topic name', { protocol: { version: 1, kind: 'task', topic: 'fleetx.deploy' } }],
    ['topic mismatch', { protocol: { version: 1, kind: 'task', topic: 'repo.other' } }],
    ['deep topic', { protocol: { version: 1, kind: 'task', topic: 'agent-a' } }],
    ['control payload ref', { protocol: { version: 1, kind: 'task', payload_ref: 'a\tb' } }],
    ['empty payload ref', { protocol: { version: 1, kind: 'task', payload_ref: '' } }],
    ['oversized payload ref', { protocol: { version: 1, kind: 'task', payload_ref: 'x'.repeat(257) } }],
  ];
  for (const [label, body] of bad) {
    const input = envelope(`fake-bad-${label.replaceAll(' ', '-')}`, 'agent-a', body);
    expect(validateBusEnvelope(input).ok, label).toBe(false);
    expect(parseBusEnvelope(JSON.stringify(input)).ok, label).toBe(false);
    expect(post(input).status, label).toBe('invalid');
  }
  // Refusal happened at validation: no inbox store was ever created on disk.
  expect(page()).toMatchObject({ status: 'ok', messages: [] });
});

it('claims a version-1 task exactly once through the real append and fencing path', () => {
  const posted = post(envelope('fake-task-1', 'fleet.deploy', {
    protocol: { version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'x'.repeat(256) },
    text: 'fake bounded ref',
  }));
  expect(posted.status).toBe('posted');
  const first = claim('fleet.deploy', 'fake-a');
  expect(first.status).toBe('acquired');
  if (first.status !== 'acquired' || !('token' in first)) throw new Error('expected a claim');
  expect(first.receipt.envelope.id).toBe('fake-task-1');
  // The stored body carries the opaque ref verbatim; the bus never fetches it.
  expect(protocolOf(first.receipt.envelope.body)).toEqual({
    version: 1, kind: 'task', topic: 'fleet.deploy', payload_ref: 'x'.repeat(256),
  });
  // Exactly once: a second claimant sees no claimable work while the lease lives.
  expect(claim('fleet.deploy', 'fake-b')).toEqual({ status: 'empty' });
  // Fencing: mutation still requires the issued token, never the labels.
  expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-task-1', token: 'b'.repeat(64), root }))
    .toMatchObject({ status: 'mismatched-token' });
  expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-task-1', token: first.token, root }))
    .toMatchObject({ status: 'completed' });
});

it('hands a released task to a later claimant under a fresh fencing token', () => {
  expect(post(envelope('fake-task-release', 'fleet.ops',
    { protocol: { version: 1, kind: 'task', topic: 'fleet.ops' } })).status).toBe('posted');
  const first = claim('fleet.ops', 'fake-a');
  if (first.status !== 'acquired' || !('token' in first)) throw new Error('expected a claim');
  expect(mutateBusWorkClaim({ action: 'release', id: 'fake-task-release', token: first.token, root }))
    .toMatchObject({ status: 'released' });
  // Failover is per message ID: the released task is claimable again, once.
  const second = claim('fleet.ops', 'fake-b');
  expect(second.status).toBe('acquired');
  if (second.status === 'acquired' && 'token' in second) {
    expect(second.token).not.toBe(first.token);
    expect(second.receipt.envelope.id).toBe('fake-task-release');
    expect(mutateBusWorkClaim({ action: 'complete', id: 'fake-task-release', token: first.token, root }))
      .toMatchObject({ status: 'mismatched-token' });
  }
});

it('keeps result, review, status and question posted but never claimable', () => {
  for (const kind of ['result', 'review', 'status', 'question']) {
    expect(post(envelope(`fake-${kind}`, 'fleet.report', {
      protocol: { version: 1, kind, topic: 'fleet.report' },
    })).status, kind).toBe('posted');
  }
  expect(post(envelope('fake-legacy-work', 'fleet.report', { kind: 'work' })).status).toBe('posted');
  const taken = claim('fleet.report');
  expect(taken.status).toBe('acquired');
  if (taken.status === 'acquired' && 'receipt' in taken) {
    expect(taken.receipt.envelope.id).toBe('fake-legacy-work');
  }
  expect(claim('fleet.report')).toEqual({ status: 'empty' });
  const listed = page();
  if (listed.status === 'ok') {
    expect(listed.messages.map(row => row.envelope.id).sort()).toEqual(
      ['fake-legacy-work', 'fake-question', 'fake-result', 'fake-review', 'fake-status']);
  }
});

it('lets a topic-less protocol task ride any exact recipient label', () => {
  // `topic` is optional: without it the task answers to the literal `to` label.
  expect(post(envelope('fake-direct', 'agent-a',
    { protocol: { version: 1, kind: 'task' }, text: 'fake direct' })).status).toBe('posted');
  expect(claim('agent-b')).toEqual({ status: 'empty' });
  const taken = claim('agent-a');
  expect(taken.status).toBe('acquired');
  if (taken.status === 'acquired' && 'receipt' in taken) {
    expect(taken.receipt.envelope.id).toBe('fake-direct');
  }
});

it('matches claim audience on the exact recipient, never a wildcard or prefix', () => {
  expect(post(envelope('fake-exact-1', 'fleet.deploy',
    { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } })).status).toBe('posted');
  // A namespace prefix is a read pattern only; claims bind the literal label.
  for (const audience of ['fleet.*', 'fleet', 'fleet.deploy.canary', 'repo.deploy']) {
    expect(claim(audience), audience).toEqual({ status: 'empty' });
  }
  expect(claim('fleet.deploy', 'fake-a').status).toBe('acquired');
});

it('accepts a task at the deepest allowed topic and refuses one segment deeper', () => {
  const deepest = 'fleet.a.b.c.d';
  expect(post(envelope('fake-deep-ok', deepest,
    { protocol: { version: 1, kind: 'task', topic: deepest } })).status).toBe('posted');
  expect(claim(deepest).status).toBe('acquired');
  const tooDeep = 'fleet.a.b.c.d.e';
  const input = envelope('fake-deep-no', tooDeep,
    { protocol: { version: 1, kind: 'task', topic: tooDeep } });
  expect(post(input).status).toBe('invalid');
  // The same address stays a usable routing label for protocol-free bodies.
  expect(post(envelope('fake-deep-legacy', tooDeep, { kind: 'work' })).status).toBe('posted');
  expect(claim(tooDeep).status).toBe('acquired');
});

it('orders two tasks on one topic by claim, one message ID per claimant', () => {
  expect(post(envelope('fake-first', 'fleet.queue',
    { protocol: { version: 1, kind: 'task', topic: 'fleet.queue' } }, { priority: 'P1' })).status).toBe('posted');
  expect(post(envelope('fake-second', 'fleet.queue',
    { protocol: { version: 1, kind: 'task', topic: 'fleet.queue' } }, { priority: 'P0' })).status).toBe('posted');
  const a = claim('fleet.queue', 'fake-a');
  const b = claim('fleet.queue', 'fake-b');
  expect(a.status).toBe('acquired');
  expect(b.status).toBe('acquired');
  if (a.status === 'acquired' && b.status === 'acquired' && 'receipt' in a && 'receipt' in b) {
    // Priority order: the P0 task goes first; each ID goes to one claimant.
    expect(a.receipt.envelope.id).toBe('fake-second');
    expect(b.receipt.envelope.id).toBe('fake-first');
  }
  expect(claim('fleet.queue', 'fake-c')).toEqual({ status: 'empty' });
});

it('treats isClaimableWork as a pure predicate over bodies', () => {
  expect(isClaimableWork({ protocol: { version: 1, kind: 'task' } })).toBe(true);
  expect(isClaimableWork({ kind: 'work' })).toBe(true);
  expect(isClaimableWork({ protocol: { version: 1, kind: 'review' } })).toBe(false);
  expect(isClaimableWork({ protocol: { version: 1, kind: 'status' }, kind: 'work' })).toBe(true);
  expect(isClaimableWork(null)).toBe(false);
  expect(isClaimableWork('work')).toBe(false);
  expect(isClaimableWork({ kind: 'result' })).toBe(false);
});
