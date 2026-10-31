import { Readable } from 'node:stream';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import { VERSE_LEADER_RESOURCES_PATH as PATH } from '../src/core/fleet/runs-resource-ledger.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function request(url: string, method = 'GET') {
  const req = Object.assign(Readable.from([]), { url, method, headers: {} }) as unknown as IncomingMessage;
  let status = 0;
  let body: unknown = null;
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
  const handled = await handleLeaderApi({} as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { handled, status, body };
}

describe('leader resources route', () => {
  it('serves the ledger through the leader handler', async () => {
    const root = join(homedir(), '.ashlr-runs');
    await mkdir(join(root, 'queue'), { recursive: true });
    await copyFile(join(process.cwd(), 'test/fixtures/runs-resource-ledger/status.json'), join(root, 'queue/status.json'));
    try {
      expect(await request(PATH)).toMatchObject({ handled: true, status: 200, body: { v: 1, sources: { status: 'healthy', apiSpend: 'missing' }, lanes: [{ lane: 'codex-personal' }, { lane: 'claude', window: 'weekly' }, { lane: 'claude-api', window: 'credits' }, { lane: 'local', window: 'none' }] } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects query strings and other methods', async () => {
    expect((await request(`${PATH}?x=1`)).status).toBe(400);
    expect((await request(`${PATH}?`)).status).toBe(400);
    expect((await request(PATH, 'POST')).status).toBe(405);
  });
});
