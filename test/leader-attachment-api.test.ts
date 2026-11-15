/**
 * POST /api/verse/leader/attachment — drives the real Leader handler in-process
 * with a raw body, under a temp runs dir. Fake image bytes only.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import { LEADER_ATTACHMENT_MAX_BYTES } from '../src/core/verse/leader-attachment-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = 'attachment-test-token';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-image-body')]);
let runs = '';
let saved: string | undefined;
let ctx: VerseApiContext;

async function post(body: Buffer, headers: Record<string, string> = {}, url = '/api/verse/leader/attachment') {
  const req = Object.assign(Readable.from(body.length ? [body] : []), {
    method: 'POST', url, headers: { 'content-type': 'image/png', 'x-ashlr-token': TOKEN, ...headers },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const rec = {
    headersSent: false,
    writeHead(code: number) { status = code; return rec; },
    setHeader() { return rec; },
    end(chunk?: string) { text += chunk ?? ''; return rec; },
  };
  await handleLeaderApi(ctx, req, rec as unknown as ServerResponse, new URL(url, 'http://localhost').pathname, 'POST');
  return { status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'leader-attach-'));
  saved = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runs;
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
});
afterEach(() => {
  if (saved === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = saved;
  rmSync(runs, { recursive: true, force: true });
});

describe('POST /api/verse/leader/attachment', () => {
  it('stores a valid PNG 0600 under inbox-attachments and answers its path', async () => {
    const r = await post(PNG);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bytes: PNG.length, type: 'image/png' });
    // The shared sendJson sanitizer redacts 64-hex digests, so check the name against our own hash.
    const prefix = createHash('sha256').update(PNG).digest('hex').slice(0, 16);
    expect(r.body.path).toBe(join(runs, 'inbox-attachments', `${prefix}.png`));
    expect(readFileSync(r.body.path).equals(PNG)).toBe(true);
    expect(statSync(r.body.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(runs, 'inbox-attachments')).mode & 0o777).toBe(0o700);
  });

  it('is idempotent for the same bytes', async () => {
    const a = await post(PNG);
    const mtime = statSync(a.body.path).mtimeMs;
    const b = await post(PNG);
    expect(b.body.path).toBe(a.body.path);
    expect(statSync(b.body.path).mtimeMs).toBe(mtime);
    expect(readdirSync(join(runs, 'inbox-attachments'))).toHaveLength(1);
  });

  it('refuses bytes that do not match the declared type (415)', async () => {
    expect((await post(Buffer.from('not an image'))).status).toBe(415);
    expect((await post(PNG, { 'content-type': 'image/jpeg' })).status).toBe(415);
  });

  it('refuses other content types (415) and oversize bodies (413)', async () => {
    expect((await post(PNG, { 'content-type': 'application/json' })).status).toBe(415);
    const big = Buffer.concat([PNG, Buffer.alloc(LEADER_ATTACHMENT_MAX_BYTES)]);
    expect((await post(big)).status).toBe(413);
    expect(() => readdirSync(join(runs, 'inbox-attachments'))).toThrow();
  });

  it('refuses what the send route refuses: no dispatch (404) and a bad token (401)', async () => {
    ctx = { ...ctx, allowDispatch: false };
    const refused = await post(PNG);
    const send = await handleSend();
    expect(refused.status).toBe(send.status);
    expect(refused.body).toEqual(send.body);
    ctx = { ...ctx, allowDispatch: true };
    expect((await post(PNG, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
  });
});

async function handleSend() {
  const req = Object.assign(Readable.from([Buffer.from('{"text":"hi"}')]), {
    method: 'POST', url: '/api/verse/leader/thread', headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const rec = { headersSent: false, writeHead(c: number) { status = c; return rec; }, setHeader() { return rec; }, end(c?: string) { text += c ?? ''; return rec; } };
  await handleLeaderApi(ctx, req, rec as unknown as ServerResponse, '/api/verse/leader/thread', 'POST');
  return { status, body: JSON.parse(text) };
}
