import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { BusWorkItemEvidenceResult } from '../src/core/comms/work-item-bus-evidence.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetWorkTraceApi } from '../src/core/verse/fleet-work-trace-api.js';

it('projects only classified, item-specific proof safely', async () => {
  const at = '2026-11-17T11:30:00Z';
  const collect = (id: string): BusWorkItemEvidenceResult => {
    if (id === 'failure') throw new Error('private failure');
    const proof = id === 'blocked' ? { blocker: { dependency: 'dep\nnext\u0001', source: 'fake', at } }
      : id === 'verified' ? { verified: { pr: 42, head: 'head\nline', tests: 'x'.repeat(210), artifact: 'file\u2028name', source: 'fake', at } }
        : id === 'partial' ? { verified: { tests: 'suite', source: 'fake', at } }
          : id === 'future' ? { verified: { tests: 'future suite', source: 'fake', at: '2026-11-17T13:00:00Z' } } : {};
    return { evidence: { id, ...proof }, sources: { inbox: 'missing', claims: 'missing', coordination: 'missing' } };
  };
  const path = '/api/verse/fleet/control/work-trace';
  const url = `${path}?id=blocked&id=verified&id=partial&id=unknown&id=failure&id=future`;
  await createFleetWorkTraceApi(collect, () => Date.parse('2026-11-17T12:00:00Z'), () => '/fake')(
    {} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, path, 'GET');
  const [, status, body] = send.mock.lastCall!;
  expect(status).toBe(200);
  expect(body).toMatchObject({ v: 1, authority: 'none', generatedAt: '2026-11-17T12:00:00.000Z' });
  const [blocked, verified, partial, unknown, failure, future] = body.items;
  expect(blocked.result).toEqual({ kind: 'blocked', dependency: 'dep next ' });
  expect(verified.result).toEqual({ kind: 'verified', pr: 42, head: 'head line', tests: 'x'.repeat(200), artifact: 'file name' });
  expect(partial.result).toEqual({ kind: 'verified', pr: null, head: null, tests: 'suite', artifact: null });
  for (const item of [unknown, failure, future]) {
    expect(item.state).toBe('RECEIVED');
    expect(item).not.toHaveProperty('result');
  }
  expect(failure).toMatchObject({ asOf: 'unknown', source: 'none', inbox: 'unavailable', claims: 'unavailable', coordination: 'unavailable' });
  expect(JSON.stringify(body)).not.toContain('private failure');
});
