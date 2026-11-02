import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import { getBusMirrorState, stopBusMirrorLoop } from '../src/core/fleet/bus-mirror-dispatch.js';
import type { BusInboxInspection } from '../src/core/fleet/bus-inbox.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/agent-bus/status';
const inspection: BusInboxInspection = {
  source: 'available', retainedCount: 0, retainedBytes: 0,
  maxMessages: 1024, maxBytes: 1024 * 1024, liveCount: 0, expiredCount: 0,
};

async function status(handler: ReturnType<typeof createAgentBusApi>, allowDispatch: boolean) {
  let code = 0, wire: Record<string, unknown> = {};
  const res = { writeHead(value: number) { code = value; return this; },
    end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; return this; } } as unknown as ServerResponse;
  const req = { url: PATH } as IncomingMessage;
  const ctx = { token: 'fake-token', allowDispatch,
    readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
  const handled = await handler(ctx, req, res, PATH, 'GET');
  return { handled, code, wire };
}

afterEach(() => stopBusMirrorLoop());

describe('agent-bus status dispatch mirror', () => {
  it('starts the mirror once across repeated status calls when dispatch is allowed', async () => {
    const startMirror = vi.fn();
    const handler = createAgentBusApi({ inspect: () => inspection, startMirror });
    for (let i = 0; i < 3; i++) {
      const reply = await status(handler, true);
      expect(reply).toMatchObject({ handled: true, code: 200 });
      expect(reply.wire).toMatchObject({ v: 1, source: 'available',
        mirror: { started: false, lastRunAt: null, posted: 0, skipped: 0, reason: null } });
    }
    expect(startMirror).toHaveBeenCalledTimes(1);
  });

  it('never starts the mirror when dispatch is not allowed', async () => {
    const startMirror = vi.fn();
    const handler = createAgentBusApi({ inspect: () => inspection, startMirror });
    const reply = await status(handler, false);
    expect(reply).toMatchObject({ handled: true, code: 200 });
    expect(reply.wire.mirror).toMatchObject({ started: false });
    expect(startMirror).not.toHaveBeenCalled();
  });

  it('does not start the mirror for the plain bus read', async () => {
    const startMirror = vi.fn();
    const handler = createAgentBusApi({
      inspect: () => inspection, startMirror,
      list: () => ({ status: 'ok', messages: [], nextCursor: 0 }),
    });
    let code = 0;
    const res = { writeHead(value: number) { code = value; return this; },
      end() { return this; } } as unknown as ServerResponse;
    const req = { url: '/api/verse/agent-bus' } as IncomingMessage;
    const ctx = { token: 'fake-token', allowDispatch: true,
      readSession: { id: 'fake-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    await handler(ctx, req, res, '/api/verse/agent-bus', 'GET');
    expect(code).toBe(200);
    expect(startMirror).not.toHaveBeenCalled();
  });

  it('arms the default loop and reports it in the mirror field', async () => {
    const handler = createAgentBusApi({ inspect: () => inspection });
    const reply = await status(handler, true);
    expect(reply.code).toBe(200);
    expect(reply.wire.mirror).toMatchObject({ started: true });
    expect(getBusMirrorState().started).toBe(true);
    stopBusMirrorLoop();
    const second = await status(handler, true);
    // The API started once; state now reports the loop is stopped.
    expect(second.wire.mirror).toMatchObject({ started: false });
  });
});
