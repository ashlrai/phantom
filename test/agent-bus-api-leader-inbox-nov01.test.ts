import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { mirrorLeaderPostToInbox } from '../src/core/fleet/bus-leader-inbox.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/agent-bus';
const token = 'fake-token';
const message: BusEnvelope = { id: 'fake-id', from: 'mason', to: 'leaders', priority: 'P0', ttl: 10000, body: { text: 'hello' } };
const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'bus-leader-api-')); roots.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

async function post(handler: ReturnType<typeof createAgentBusApi>, envelope: BusEnvelope) {
  const req = Readable.from([JSON.stringify(envelope)]) as unknown as IncomingMessage;
  req.url = path; req.headers = { 'content-type': 'application/json', 'x-ashlr-token': token };
  let status = 0, wire: Record<string, unknown> = {};
  const res = { writeHead(code: number) { status = code; }, end(body: string) { wire = JSON.parse(body) as Record<string, unknown>; } } as unknown as ServerResponse;
  const ctx = { token, allowDispatch: true } as VerseApiContext;
  await handler(ctx, req, res, path, 'POST');
  return { status, wire };
}

describe('bus HTTP leader inbox bridge', () => {
  it('mirrors successful posts and retries only once', async () => {
    const dir = root(), runsDir = join(dir, 'runs');
    const handler = createAgentBusApi({ append: value => appendBusInbox(value, { root: dir }),
      mirrorToInbox: value => mirrorLeaderPostToInbox(value, { runsDir }) });
    expect(await post(handler, message)).toMatchObject({ status: 201, wire: { inbox: { appended: true } } });
    expect(await post(handler, message)).toMatchObject({ status: 200, wire: { inbox: { appended: false } } });
    expect(await post(handler, { ...message, id: 'agent-id', from: 'agent' })).toMatchObject({ wire: { inbox: { appended: false } } });
    expect(await post(handler, { ...message, id: 'other-id', to: 'agent' })).toMatchObject({ wire: { inbox: { appended: false } } });
    expect((await readInboxEntries({ runsDir })).entries).toMatchObject([{ source: 'desktop', text: '[bus→leaders] hello' }]);
  });
  it('returns success and logs once when inbox writing fails, then allows a retry', async () => {
    const dir = root(), runsDir = join(dir, 'runs');
    mkdirSync(runsDir);
    const leaderDir = join(runsDir, 'leader');
    // Root can bypass directory permissions, so use an equivalent blocker there.
    if (process.getuid?.() === 0) writeFileSync(leaderDir, 'blocks inbox directory');
    else { mkdirSync(leaderDir); chmodSync(leaderDir, 0o555); }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createAgentBusApi({ append: value => appendBusInbox(value, { root: dir }),
      mirrorToInbox: value => mirrorLeaderPostToInbox(value, { runsDir }) });
    expect(await post(handler, message)).toMatchObject({ status: 201, wire: { inbox: { appended: false } } });
    expect(warn).toHaveBeenCalledTimes(1);
    if (process.getuid?.() === 0) rmSync(leaderDir);
    else chmodSync(leaderDir, 0o755);
    expect(await post(handler, message)).toMatchObject({ status: 200, wire: { inbox: { appended: true } } });
  });
  it('does not mirror failed bus writes and contains thrown mirror errors', async () => {
    const mirror = vi.fn(() => Promise.reject(new Error('fake sensitive detail')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = createAgentBusApi({ append: () => ({ status: 'full' }), mirrorToInbox: mirror });
    expect((await post(failure, message)).status).toBe(507);
    expect(mirror).not.toHaveBeenCalled();
    const success = createAgentBusApi({ append: () => ({ status: 'posted', cursor: 1 }), mirrorToInbox: mirror });
    expect(await post(success, message)).toMatchObject({ status: 201, wire: { inbox: { appended: false } } });
    expect(warn).toHaveBeenCalledExactlyOnceWith('Agent bus leader inbox mirror failed.');
  });
  it('bounds a stalled mirror without changing the bus response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createAgentBusApi({ append: () => ({ status: 'posted', cursor: 1 }),
      mirrorToInbox: () => new Promise(() => {}) });
    expect(await post(handler, message)).toMatchObject({ status: 201, wire: { inbox: { appended: false } } });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
