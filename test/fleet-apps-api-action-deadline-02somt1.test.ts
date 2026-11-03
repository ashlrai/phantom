import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const accepted = { stdout: JSON.stringify({ ok: true, code: 'requested' }), stderr: '' };
function call(api: ApiModule, body: unknown) {
  const req = Object.assign(new PassThrough(), {
    headers: { 'x-ashlr-token': 'test', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
  const result = { status: 0, body: '', sends: 0 };
  const res = { writeHead(code: number) { result.status = code; return this; }, end(text: string) { result.body = text; result.sends++; } } as unknown as ServerResponse;
  const pending = api({ allowDispatch: true, token: 'test' } as VerseApiContext, req, res, '/api/verse/fleet/apps/action', 'POST');
  (req as unknown as PassThrough).end(JSON.stringify(body));
  return { result, pending };
}
const make = (exec: ReturnType<typeof vi.fn>) => createFleetAppsApi({ exec, locateScript: () => '/fake/script', runsDir: '/fake/runs' });
const launch = { app: 'Codex', action: 'launch' };
afterEach(() => vi.useRealTimers());

describe('fleet app action wall deadline', () => {
  it('times out a hung action, releases the app, and consumes a late rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let reject!: (error: Error) => void;
    const exec = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(accepted);
    const api = make(exec);
    const first = call(api, launch);
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await first.pending;
    expect(first.result.status).toBe(504);
    expect(JSON.parse(first.result.body)).toEqual({ code: 'VERSE_ACTION_TIMEOUT', error: 'app action not accepted in time' });
    const second = call(api, launch);
    await vi.advanceTimersByTimeAsync(0);
    await second.pending;
    expect(second.result.status).toBe(202);
    reject(new Error('private child failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.result.sends).toBe(1);
    expect(first.result.body).not.toContain('private');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('gives confirmation only the remaining budget and never confirms after expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let accept!: (value: typeof accepted) => void;
    let confirm!: (value: typeof accepted) => void;
    const exec = vi.fn().mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const request = call(make(exec), { ...launch, waitRunningMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_900);
    accept(accepted);
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1]![2].timeout).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    await request.pending;
    expect(request.result.status).toBe(202);
    expect(JSON.parse(request.result.body).confirmation.confirmed).toBe(false);
    confirm({ stdout: JSON.stringify({ ok: true, running: true }), stderr: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(request.result.sends).toBe(1);
  });

  it('preserves timely focus acceptance', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const request = call(make(vi.fn().mockResolvedValue(accepted)), { app: 'Codex', action: 'focus' });
    await vi.advanceTimersByTimeAsync(0);
    await request.pending;
    expect(request.result.status).toBe(202);
    expect(JSON.parse(request.result.body)).toMatchObject({ app: 'Codex', action: 'focus', code: 'requested' });
  });
});
