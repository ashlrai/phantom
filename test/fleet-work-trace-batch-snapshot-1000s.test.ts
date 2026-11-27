import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidenceBatch, readBusInboxEvidence, readBusClaimAuthority } from '../src/core/comms/work-item-bus-evidence.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetWorkTraceApi } from '../src/core/verse/fleet-work-trace-api.js';

const path = '/api/verse/fleet/control/work-trace';
const now = Date.parse('2026-11-17T12:00:00Z');
const root = mkdtempSync(join(tmpdir(), 'trace-batch-'));
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function request(api: ReturnType<typeof createFleetWorkTraceApi>, ids: string[]) {
  const url = `${path}?${ids.map(id => `id=${id}`).join('&')}`;
  await api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, path, 'GET');
  return send.mock.lastCall![2] as { items: Array<{ id: string; state: string; inbox: string; claims: string; coordination: string }> };
}

describe('work trace batch observation', () => {
  it('reads each store once per request, preserves duplicates and observes later generations and failures', async () => {
    const ids = Array.from({ length: 19 }, (_, i) => `item-${i}`);
    for (const id of ids) {
      expect(appendBusInbox({ id, from: 'fake', to: 'fake', priority: 'P1', ttl: 1000000,
        body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    }
    const inbox = vi.fn(readBusInboxEvidence);
    const claims = vi.fn(inspectBusWorkClaims);
    const coordination = vi.fn(readBusClaimAuthority);
    const batch = (requested: readonly string[], options: { root: string; now: number }) =>
      collectBusWorkItemEvidenceBatch(requested, options, { inbox, claims, coordination });
    const api = createFleetWorkTraceApi(undefined, () => now, () => root, batch);
    const requested = [...ids, ids[0]!];
    const first = await request(api, requested);
    expect(first.items.map(item => item.id)).toEqual(requested);
    expect(first.items.every(item => item.inbox === 'found' && item.state === 'RECEIVED')).toBe(true);
    expect(first.items[0]).toEqual(first.items[19]);
    expect([inbox.mock.calls.length, claims.mock.calls.length, coordination.mock.calls.length]).toEqual([1, 1, 1]);

    for (const [index, id] of ids.entries()) {
      expect(appendBusInbox({ id: `reply-${index}`, from: 'fake', to: 'fake', priority: 'P1', ttl: 1000000,
        body: { inReplyTo: id, verified: { tests: 'passed' } } }, { root, now: () => now }).status).toBe('posted');
    }
    const second = await request(api, requested);
    expect(second.items.every(item => item.state === 'VERIFIED')).toBe(true);
    expect([inbox.mock.calls.length, claims.mock.calls.length, coordination.mock.calls.length]).toEqual([2, 2, 2]);

    inbox.mockImplementationOnce(() => { throw new Error('private'); });
    const failed = await request(api, requested);
    expect(failed.items.every(item => item.inbox === 'unavailable' && item.state === 'RECEIVED')).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('private');
    expect([inbox.mock.calls.length, claims.mock.calls.length, coordination.mock.calls.length]).toEqual([3, 3, 3]);
    claims.mockImplementationOnce(() => { throw new Error('private'); });
    coordination.mockImplementationOnce(() => { throw new Error('private'); });
    const unavailable = await request(api, requested);
    expect(unavailable.items.every(item => item.claims === 'unavailable' && item.coordination === 'unavailable' && item.state === 'VERIFIED')).toBe(true);
  });
});
