import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetWorkTraceApi } from '../src/core/verse/fleet-work-trace-api.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';

const path = '/api/verse/fleet/control/work-trace';
const NOW = Date.parse('2026-11-17T12:00:00Z');
const ok = (evidence: Record<string, unknown>) => ({ evidence, sources: { inbox: 'found', claims: 'available' } }) as never;
const fake = (id: string) => {
  if (id === 'msg-assigned') return ok({ id, receivedAt: '2026-11-17T11:00:00.000Z', owner: 'fake-owner', claimReceipt: 'bus-claim:msg-assigned:1:2' });
  if (id === 'msg-verified') return ok({ id, receivedAt: '2026-11-17T11:00:00.000Z', verified: { tests: 'fake suite', source: 'bus-reply:r1', at: '2026-11-17T11:30:00.000Z' } });
  return ok({ id, receivedAt: '2026-11-17T11:00:00.000Z' });
};
const call = (api: ReturnType<typeof createFleetWorkTraceApi>, url: string, method = 'GET') =>
  api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);
const q = (...ids: string[]) => `${path}?${ids.map(id => `id=${encodeURIComponent(id)}`).join('&')}`;
const api = () => createFleetWorkTraceApi(fake as never, () => NOW, () => '/fake-root');

describe('fleet work-trace api (555)', () => {
  it('classifies a batch from one clock', async () => {
    await call(api(), q('msg-received', 'msg-assigned', 'msg-verified'));
    const [, status, body] = send.mock.lastCall!;
    expect(status).toBe(200);
    expect(body).toMatchObject({ v: 1, authority: 'none', generatedAt: '2026-11-17T12:00:00.000Z' });
    expect(body.items.map((i: { id: string; state: string }) => [i.id, i.state]))
      .toEqual([['msg-received', 'RECEIVED'], ['msg-assigned', 'ASSIGNED'], ['msg-verified', 'VERIFIED']]);
    expect(body.items[1]).toMatchObject({ owner: 'fake-owner', claimReceipt: 'bus-claim:msg-assigned:1:2', inbox: 'found', claims: 'available' });
    expect(body.items[0]).toMatchObject({ owner: null, claimReceipt: null });
  });
  it('rejects bad queries with 400 and never collects', async () => {
    const collect = vi.fn();
    const strict = createFleetWorkTraceApi(collect as never, () => NOW, () => '/fake-root');
    const many = Array.from({ length: 21 }, (_, i) => `m${i}`);
    for (const url of [q(...many), `${q('a')}&file=/x`, `${path}?id=`, `${path}?id=%20`, path, q('x'.repeat(201)), `${path}?id=a%00b`]) {
      await call(strict, url); expect(send.mock.lastCall![1]).toBe(400);
    }
    await call(strict, q(...many.slice(0, 20))); expect(send.mock.lastCall![1]).toBe(200);
    expect(collect).toHaveBeenCalledTimes(20);
  });
  it('turns a throwing collector into RECEIVED/unknown for that id only, without its message', async () => {
    const flaky = createFleetWorkTraceApi(((id: string) => { if (id === 'bad') throw new Error('PRIVATE-DETAIL'); return fake(id); }) as never, () => NOW, () => '/r');
    await call(flaky, q('msg-assigned', 'bad'));
    const body = send.mock.lastCall![2];
    expect(body.items[0].state).toBe('ASSIGNED');
    expect(body.items[1]).toMatchObject({ id: 'bad', state: 'RECEIVED', asOf: 'unknown' });
    expect(body.items[1].missing.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('PRIVATE-DETAIL');
  });
  it('is GET only and ignores other paths', async () => {
    await call(api(), q('a'), 'POST'); expect(send.mock.lastCall![1]).toBe(405);
    expect(await call(api(), '/other')).toBe(false);
  });
  it('is mounted through handleFleetControlApi', async () => {
    send.mockClear();
    expect(await handleFleetControlApi({} as VerseApiContext, { url: q('fake-unknown') } as IncomingMessage, {} as ServerResponse, path, 'GET')).toBe(true);
    expect(send.mock.lastCall![1]).toBe(200);
    expect(send.mock.lastCall![2].items[0]).toMatchObject({ id: 'fake-unknown', state: 'RECEIVED' });
  });
});
