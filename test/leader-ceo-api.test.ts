import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/leader/inbox';
const token = 'fixture-local-dispatch';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-ceo-api-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  mkdirSync(join(root, '.ashlr'), { mode: 0o700 });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function configuration(options: { owner?: boolean; team?: boolean; approved?: boolean } = {}): void {
  writeFileSync(join(root, '.ashlr', 'agent-network.toml'), `
[team]
identities = ${options.team === false ? '[]' : '[{channel="bus",id="leader"},{channel="bus",id="local-owner"}]'}
[mason]
identities = ${options.owner === false ? '[]' : '[{channel="bus",id="local-owner"}]'}
`, { mode: 0o600 });
  writeFileSync(join(root, '.ashlr', 'comms.toml'), `confirmedByMason = ${options.approved !== false}\n`, { mode: 0o600 });
}

async function request(method: string, body?: unknown, options: { authorized?: boolean; dispatch?: boolean; readSession?: boolean } = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    method, url: path,
    headers: { 'content-type': 'application/json', ...(options.authorized === false ? {} : { 'x-ashlr-token': token }) },
  }) as IncomingMessage;
  let status = 0;
  let result: unknown;
  const res = {
    writeHead(code: number) { status = code; }, setHeader() {},
    end(value: string) { result = JSON.parse(value); },
  } as unknown as ServerResponse;
  const ctx = { allowDispatch: options.dispatch !== false, token,
    ...(options.readSession ? { readSession: { expiresAt: Date.now() + 60_000 } } : {}) } as VerseApiContext;
  await handleLeaderApi(ctx, req, res, path, method);
  return { status, body: result };
}

describe('Leader durable inbox API', () => {
  it('requires dispatch authority and mutation token before accepting a desktop message', async () => {
    configuration();
    expect((await request('POST', { text: 'Synthetic fixture message' }, { dispatch: false })).status).toBe(404);
    expect((await request('POST', { text: 'Synthetic fixture message' }, { authorized: false })).status).toBe(401);
    expect((await request('PUT', {})).status).toBe(405);
  });

  it('refuses missing approval, a non-team recipient, and an unverified local owner', async () => {
    configuration({ approved: false });
    expect((await request('POST', { text: 'Synthetic fixture message' })).status).toBe(403);
    configuration({ team: false });
    expect((await request('POST', { text: 'Synthetic fixture message' })).status).toBe(403);
    configuration({ owner: false });
    expect((await request('POST', { text: 'Synthetic fixture message' })).status).toBe(403);
  });

  it('does not let the body claim a sender or choose a different source', async () => {
    configuration();
    for (const body of [null, [], { text: 'Synthetic fixture', verifiedSender: 'local-owner' },
      { text: 'Synthetic fixture', source: 'telegram' }, { text: 42 }]) {
      expect((await request('POST', body)).status).toBe(400);
    }
  });

  it('writes an accepted message to the durable inbox and exposes it through a read session', async () => {
    configuration();
    const result = await request('POST', { text: 'Synthetic accepted fixture', source: 'Phantom desktop' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'runs', 'leader', 'MASON-INBOX.md'), 'utf8')).toContain('Synthetic accepted fixture');
    const view = await request('GET', undefined, { readSession: true });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ schema: 'leader.inbox.v1', inbox: { entries: [{ text: 'Synthetic accepted fixture' }] } });
  });

  it('requires an active read session for the durable conversation', async () => {
    expect((await request('GET')).status).toBe(401);
  });
});
