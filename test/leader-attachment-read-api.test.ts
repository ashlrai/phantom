/**
 * GET /api/verse/leader/attachment/<name> — drives the real Leader handler
 * in-process under a temp runs dir. Fake image bytes only.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import { handleLeaderAttachmentRead } from '../src/core/verse/leader-attachment-read-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = 'attachment-read-test-token';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-image-body')]);
const NAME = `${createHash('sha256').update(PNG).digest('hex').slice(0, 16)}.png`;
let runs = '';
let saved: string | undefined;
let ctx: VerseApiContext;

interface Reply { status: number; headers: Record<string, string>; body: Buffer }

function rec(): { res: ServerResponse; reply: Reply } {
  const reply: Reply = { status: 0, headers: {}, body: Buffer.alloc(0) };
  const rec = {
    headersSent: false,
    writeHead(code: number, headers: Record<string, string> = {}) {
      reply.status = code;
      for (const [name, value] of Object.entries(headers)) reply.headers[name.toLowerCase()] = value;
      return rec;
    },
    setHeader(name: string, value: string) { reply.headers[name.toLowerCase()] = value; return rec; },
    end(chunk?: Buffer | string) { if (chunk) reply.body = Buffer.concat([reply.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); return rec; },
  };
  return { res: rec as unknown as ServerResponse, reply };
}

async function post(body: Buffer, headers: Record<string, string> = {}) {
  const url = '/api/verse/leader/attachment';
  const req = Object.assign(Readable.from([body]), {
    method: 'POST', url, headers: { 'content-type': 'image/png', 'x-ashlr-token': TOKEN, ...headers },
  }) as unknown as IncomingMessage;
  const { res, reply } = rec();
  await handleLeaderApi(ctx, req, res, new URL(url, 'http://localhost').pathname, 'POST');
  return reply;
}

async function get(name: string, headers: Record<string, string> = {}, method = 'GET') {
  const url = `/api/verse/leader/attachment/${name}`;
  const req = Object.assign(Readable.from([]), {
    method, url, headers: { 'x-ashlr-token': TOKEN, ...headers },
  }) as unknown as IncomingMessage;
  const { res, reply } = rec();
  await handleLeaderApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return reply;
}

/** Plant bytes in the store under `name` (the shape the POST writes). */
function plant(name: string, bytes: Buffer = PNG) {
  const dir = join(runs, 'inbox-attachments');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'leader-attach-read-'));
  saved = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runs;
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
});
afterEach(() => {
  if (saved === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = saved;
  rmSync(runs, { recursive: true, force: true });
});

describe('GET /api/verse/leader/attachment/<name>', () => {
  it('serves a stored PNG with its type, bytes and bounded cache headers', async () => {
    expect((await post(PNG)).status).toBe(200);
    const r = await get(NAME);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('private, max-age=86400');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body.equals(PNG)).toBe(true);
  });

  it('refuses names that are not the stored shape (404)', async () => {
    plant(NAME);
    // '..' in a request path is resolved away by URL parsing before dispatch;
    // the encoded form survives and the name regex still refuses it.
    for (const bad of ['notanimage.png', '0123456789abcdef', '0123456789abcdef.PNG', '0123456789abcdef.png/extra', '..%2F..%2Fetc%2Fpasswd']) {
      expect((await get(bad)).status, bad).toBe(404);
    }
    // A raw '..' name reaching the handler unnormalized is refused the same way.
    const req = Object.assign(Readable.from([]), { method: 'GET', url: '/api/verse/leader/attachment/../x.png', headers: { 'x-ashlr-token': TOKEN } }) as unknown as IncomingMessage;
    const { res, reply } = rec();
    await handleLeaderAttachmentRead(ctx, req, res, 'GET', '../x.png');
    expect(reply.status).toBe(404);
  });

  it('refuses a symlink even under a valid name (404)', async () => {
    const real = join(runs, 'elsewhere.png');
    writeFileSync(real, PNG);
    mkdirSync(join(runs, 'inbox-attachments'), { recursive: true });
    symlinkSync(real, join(runs, 'inbox-attachments', NAME));
    expect((await get(NAME)).status).toBe(404);
  });

  it('refuses stored bytes whose magic disagrees with the extension (415)', async () => {
    plant(NAME, Buffer.from('not an image'));
    expect((await get(NAME)).status).toBe(415);
  });

  it('refuses what the write route refuses: no dispatch (404) and a bad token (401)', async () => {
    plant(NAME);
    ctx = { ...ctx, allowDispatch: false };
    expect((await get(NAME)).status).toBe(404);
    ctx = { ...ctx, allowDispatch: true };
    expect((await get(NAME, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
  });

  it('answers 405 to a non-GET method', async () => {
    expect((await get(NAME, {}, 'POST')).status).toBe(405);
  });

  it('404s a well-formed name that was never stored', async () => {
    expect((await get(NAME)).status).toBe(404);
    expect(() => readFileSync(join(runs, 'inbox-attachments', NAME))).toThrow();
  });
});
