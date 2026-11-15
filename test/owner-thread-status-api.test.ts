import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function call(path = `${VERSE_OWNER_THREAD_PATH}/status`, method = 'GET', allowDispatch = true, statusBrief = async () => 'One\nTwo') {
  const dir = mkdtempSync(join(tmpdir(), 'status-api-'));
  try {
    let status = 0, text = '';
    const req = Object.assign(new PassThrough(), { url: path, method }) as IncomingMessage;
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const brief = vi.fn(statusBrief);
    const api = createOwnerThreadApi({ runsDir: dir, configDir: dir, statusBrief: brief, now: () => 0 });
    const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, path, method);
    return { handled, status, body: JSON.parse(text), brief };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('owner status API', () => {
  it('returns the injected brief and timestamp', async () => {
    const result = await call();
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ schema: 'comms.owner-status.v1', text: 'One\nTwo', at: '1970-01-01T00:00:00.000Z' });
  });
  it('requires dispatch authority', async () => {
    const result = await call(undefined, 'GET', false);
    expect(result.status).toBe(404);
    expect(result.brief).not.toHaveBeenCalled();
  });
  it('rejects POST', async () => { expect((await call(undefined, 'POST')).status).toBe(405); });
  it('reports an unavailable brief', async () => {
    const result = await call(undefined, 'GET', true, async () => { throw new Error('failed'); });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ schema: 'comms.owner-status.v1', unavailable: true });
  });
  it('continues to serve the owner thread', async () => {
    const result = await call(VERSE_OWNER_THREAD_PATH);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ schema: 'comms.owner-thread.v1', messages: [] });
    expect(result.brief).not.toHaveBeenCalled();
  });
});
