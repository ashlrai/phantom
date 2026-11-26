import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { BusWorkItemEvidenceResult } from '../src/core/comms/work-item-bus-evidence.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetWorkTraceApi } from '../src/core/verse/fleet-work-trace-api.js';

const path = '/api/verse/fleet/control/work-trace';
const now = Date.parse('2026-11-17T12:00:00Z');

describe('work-trace coordination availability', () => {
  it('projects every source state and isolates collector failures without changing claim evidence', async () => {
    const collect = (id: string): BusWorkItemEvidenceResult => {
      if (id === 'broken') throw new Error('synthetic-private-message /fake/private/path');
      const coordination = id as BusWorkItemEvidenceResult['sources']['coordination'];
      return {
        evidence: { id, receivedAt: '2026-11-17T11:00:00.000Z',
          ...(id === 'unavailable' ? { owner: 'fake-owner', claimReceipt: 'bus-claim:unavailable:1:2' } : {}) },
        sources: { inbox: 'found', claims: 'available', coordination },
      };
    };
    const api = createFleetWorkTraceApi(collect, () => now, () => '/fake-root');
    const url = `${path}?id=unavailable&id=broken&id=available&id=missing`;
    await api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, path, 'GET');
    const [, status, body] = send.mock.lastCall!;
    expect(status).toBe(200);
    expect(body).toMatchObject({ v: 1, authority: 'none', generatedAt: '2026-11-17T12:00:00.000Z' });
    expect(body.items).toMatchObject([
      { id: 'unavailable', state: 'ASSIGNED', owner: 'fake-owner', claimReceipt: 'bus-claim:unavailable:1:2', inbox: 'found', claims: 'available', coordination: 'unavailable' },
      { id: 'broken', state: 'RECEIVED', asOf: 'unknown', source: 'none', missing: ['work-item evidence'], owner: null, claimReceipt: null, inbox: 'unavailable', claims: 'unavailable', coordination: 'unavailable' },
      { id: 'available', state: 'RECEIVED', owner: null, claimReceipt: null, coordination: 'available' },
      { id: 'missing', state: 'RECEIVED', owner: null, claimReceipt: null, coordination: 'missing' },
    ]);
    const json = JSON.stringify(body);
    expect(json).not.toContain('synthetic-private-message');
    expect(json).not.toContain('/fake/private/path');
    expect(json).not.toMatch(/fencing|token|credential/i);
  });
});
