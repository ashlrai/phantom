import { randomBytes, createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGithubWebhookHandler } from '../src/api/github-webhook.js';

describe('GitHub webhook ingest', () => {
  let directory: string;
  const secret = randomBytes(32).toString('hex');
  let handle: ReturnType<typeof createGithubWebhookHandler>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'github-ingest-'));
    handle = createGithubWebhookHandler({ secret, eventDirectory: directory });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  function request(event = 'check_run', id = 'delivery-1', body = JSON.stringify({ action: 'completed', [event]: { id: 42 } })) {
    return new Request('http://localhost/api/github/webhook', {
      method: 'POST', body, headers: {
        'x-github-event': event, 'x-github-delivery': id,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
    });
  }
  it.each(['check_run', 'pull_request'])('persists authenticated %s payload', async (event) => {
    const req = request(event);
    const payload = await req.clone().json();
    expect((await handle(req)).status).toBe(202);
    expect(JSON.parse(await readFile(join(directory, 'delivery-1.json'), 'utf8'))).toMatchObject({
      v: 1, event, deliveryId: 'delivery-1', payload,
    });
  });
  it('refuses bad signatures without consuming the delivery id', async () => {
    const req = request();
    req.headers.set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`);
    expect((await handle(req)).status).toBe(401);
    expect(await readdir(directory)).toEqual([]);
    expect((await handle(request())).status).toBe(202);
  });
  it('verifies exact bytes rather than parsed JSON', async () => {
    const signed = request();
    const altered = new Request(signed.url, {
      method: 'POST', headers: signed.headers,
      body: ' ' + await signed.text(),
    });
    expect((await handle(altered)).status).toBe(401);
    expect(await readdir(directory)).toEqual([]);
  });
  it('only handles POST at the configured route', async () => {
    expect((await handle(new Request('http://localhost/api/github/webhook'))).status).toBe(405);
    expect((await handle(new Request('http://localhost/other'))).status).toBe(404);
  });
  it('requires explicit configuration', () => {
    expect(() => createGithubWebhookHandler({ secret: '', eventDirectory: directory })).toThrow();
  });
  it('rejects replay after handler restart', async () => {
    expect((await handle(request())).status).toBe(202);
    handle = createGithubWebhookHandler({ secret, eventDirectory: directory });
    expect((await handle(request('pull_request'))).status).toBe(409);
    expect(await readdir(directory)).toEqual(['delivery-1.json']);
  });
  it('accepts only one concurrent delivery across independent handlers', async () => {
    const other = createGithubWebhookHandler({ secret, eventDirectory: directory });
    const responses = await Promise.all([handle(request()), other(request())]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 409]);
    expect(await readdir(directory)).toEqual(['delivery-1.json']);
  });
  it.each(['', 'sha256=bad', `sha1=${'0'.repeat(40)}`])('rejects malformed signatures: %s', async signature => {
    const req = request();
    req.headers.set('x-hub-signature-256', signature);
    expect((await handle(req)).status).toBe(401);
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['null', '[]', '{}', '{'])('rejects invalid signed payloads: %s', async body => {
    expect((await handle(request('check_run', 'delivery-1', body))).status).toBe(400);
    expect(await readdir(directory)).toEqual([]);
  });
  it('bounds streamed bodies', async () => {
    expect((await handle(request('check_run', 'delivery-1', 'x'.repeat(1024 * 1024 + 1)))).status).toBe(413);
    expect(await readdir(directory)).toEqual([]);
  });
  it('refuses path traversal delivery ids', async () => {
    expect((await handle(request('check_run', '../escape'))).status).toBe(400);
  });
  it('refuses unsupported events', async () => {
    expect((await handle(request('push'))).status).toBe(422);
  });
  it('reports persistence errors without acknowledging delivery', async () => {
    handle = createGithubWebhookHandler({ secret, eventDirectory: join(directory, 'missing', '..', 'delivery-1.json', 'child') });
    await createGithubWebhookHandler({ secret, eventDirectory: directory })(request());
    expect((await handle(request())).status).toBe(503);
  });
});
