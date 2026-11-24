import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The local write gate reads the real kill switch and pause state; drive it directly.
const gate = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock('../src/core/agents/send-gate.js', () => ({
  localWriteGate: () => (gate.reason ? { status: 'refused', reason: gate.reason } : null),
}));

const { createBusRouter, createMemoryDeadLetterSink } = await import('../src/core/fleet/bus-transport.js');
const { createFileBusTransport, createFileDeadLetterSink } = await import('../src/core/fleet/bus-transport-file.js');
const { listBusInboxAfter } = await import('../src/core/fleet/bus-inbox.js');

const roots: string[] = [];
afterEach(() => {
  gate.reason = null;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'bus-hold-')); roots.push(root); return root; };

const envelope = {
  id: 'msg-1', from: 'agent:planner', to: 'reviewer', kind: 'task' as const, priority: 'P1' as const,
  body: { text: 'x' }, correlationId: 'corr-1', ttlMs: 60_000,
};

it('holds every delivery by default while the kill switch or pause is on', async () => {
  const root = setup();
  const deadLetter = createMemoryDeadLetterSink();
  const router = createBusRouter({
    deadLetter, routes: [{ transport: createFileBusTransport({ root, addresses: ['*'] }), roles: ['*'], priority: 0 }],
  });
  gate.reason = 'Kill switch is on.';
  expect(await router.deliver(envelope)).toEqual({ status: 'held', id: 'msg-1', correlationId: 'corr-1', reason: 'Kill switch is on.' });
  expect(deadLetter.entries).toHaveLength(0);
  gate.reason = null;
  expect(await router.deliver(envelope)).toMatchObject({ status: 'delivered' });
});

it('gates the file transport and dead-letter sink for callers that bypass the router', async () => {
  const root = setup();
  gate.reason = 'Communications are paused.';
  const transport = createFileBusTransport({ root, addresses: ['*'] });
  expect(await transport.send(envelope)).toEqual({ ok: false, retryable: true, reason: 'Communications are paused.' });
  const sink = createFileDeadLetterSink({ root });
  expect(await sink.put({ envelope, reason: 'exhausted', attempts: [], deadLetteredAt: 1 })).toEqual({ ok: false });
  expect(listBusInboxAfter(0, 10, { root })).toMatchObject({ status: 'ok', messages: [] });
});
