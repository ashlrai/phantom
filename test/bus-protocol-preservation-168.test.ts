import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { claimNextBusWork } from '../src/core/fleet/bus-next-claim.js';

it('ingests typed tasks and legacy work without executing typed responses', () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-preservation-'));
  try {
    const post = (id: string, body: unknown) => appendBusInbox({ id, from: 'fake-sender', to: 'fleet.ops', priority: 'P2', ttl: 120_000, body }, { root });
    const claim = (owner: string) => claimNextBusWork({ to: 'fleet.ops', owner, leaseMs: 60_000, root });
    expect(post('bad', { protocol: { version: 1, kind: 'task', topic: 'repo.other' } }).status).toBe('invalid');
    for (const kind of ['status', 'result']) {
      expect(post(kind, { kind: 'work', protocol: { version: 1, kind } }).status).toBe('posted');
    }
    expect(post('task', { protocol: { version: 1, kind: 'task', topic: 'fleet.ops', payload_ref: 'https://invalid.example/fake' } }).status).toBe('posted');
    const first = claim('fake-a');
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') throw new Error('expected task');
    expect(first.receipt.envelope.id).toBe('task');
    expect(claim('fake-b')).toEqual({ status: 'empty' });
    expect(post('legacy', { kind: 'work' }).status).toBe('posted');
    const legacy = claim('fake-b');
    expect(legacy.status).toBe('acquired');
    if (legacy.status !== 'acquired') throw new Error('expected legacy work');
    expect(legacy.receipt.envelope.id).toBe('legacy');
    expect(claim('fake-c')).toEqual({ status: 'empty' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
