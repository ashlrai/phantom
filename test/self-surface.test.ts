import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SelfSurfaceBroker, parseSelfRequest, publishSelfSurfaceEndpoint, readSelfSurfaceEndpoint, selfTokenMatches, type SelfSurfaceDeps } from '../src/core/verse/self-surface.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'self-surface-')); roots.push(r); return r; };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

function broker(extra: SelfSurfaceDeps = {}) {
  const posted: unknown[] = [];
  let n = 0;
  const b = new SelfSurfaceBroker({ postIntent: (e) => { posted.push(e); return { status: 'posted' }; }, id: () => `cmd-${++n}`,
    killed: () => false, commsPaused: () => false, timeoutMs: 1_000, ...extra });
  return { b, posted };
}

/** A fake webview: poll once, answer with `answer`. */
async function serve(b: SelfSurfaceBroker, answer: (request: unknown) => unknown) {
  const command = await b.next(1_000);
  expect(command).not.toBeNull();
  b.complete(command!.id, answer(command!.request));
}

// Built at runtime so secret scanners never see a token-shaped literal.
const FAKE_PAT = ['ghp', 'FAKEefghijklmnopqrstuvwxyz0123456789AB'].join('_');

describe('self-surface broker', () => {
  it('parses only the four verbs with bounded arguments', () => {
    expect(parseSelfRequest({ verb: 'snapshot' })).toEqual({ verb: 'snapshot' });
    expect(parseSelfRequest({ verb: 'act', testId: 'fleet' })).toEqual({ verb: 'act', testId: 'fleet', action: 'click' });
    expect(parseSelfRequest({ verb: 'navigate', section: 'Settings' })).toBeNull();
    expect(parseSelfRequest({ verb: 'act', testId: 'x', action: 'type' })).toBeNull();
    expect(parseSelfRequest({ verb: 'snapshot', extra: 1 })).toBeNull();
    expect(parseSelfRequest({ verb: 'eval', code: '1' })).toBeNull();
  });

  it('refuses when no window is connected', async () => {
    const { b, posted } = broker();
    expect(await b.submit({ verb: 'snapshot' })).toMatchObject({ ok: false, code: 'no_client' });
    expect(posted).toEqual([]);
  });

  it('posts a bus intent first, then hands the request to the webview and scrubs its answer', async () => {
    const { b, posted } = broker();
    void b.next(0);
    await new Promise((r) => setTimeout(r, 5));
    const pending = b.submit({ verb: 'snapshot' });
    await serve(b, () => ({ ok: true, data: { title: 'Phantom', note: 'token=' + FAKE_PAT } }));
    const result = await pending;
    expect(result).toMatchObject({ ok: true, verb: 'snapshot', data: { title: 'Phantom', untrusted: true } });
    expect(JSON.stringify(result)).not.toContain(FAKE_PAT);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ from: 'self-surface', body: { kind: 'desktop.intent', verb: 'self-snapshot', app: 'Phantom' } });
  });

  it('refuses writes under KILL and comms pause, keeps reads, and refuses anything the bus will not log', async () => {
    const killed = broker({ killed: () => true });
    void killed.b.next(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(await killed.b.submit({ verb: 'act', testId: 'fleet' })).toMatchObject({ ok: false, code: 'killed' });
    expect(await broker({ commsPaused: () => true }).b.submit({ verb: 'navigate', section: 'fleet' })).toMatchObject({ ok: false, code: 'comms_paused' });
    const read = killed.b.submit({ verb: 'snapshot' });
    await serve(killed.b, () => ({ ok: true, data: {} }));
    expect(await read).toMatchObject({ ok: true });
    const silent = broker({ postIntent: () => ({ status: 'unavailable' }) });
    void silent.b.next(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(await silent.b.submit({ verb: 'snapshot' })).toMatchObject({ ok: false, code: 'intent_not_posted' });
  });

  it('writes screenshots 0600 and returns bytes only on opt-in', async () => {
    const dir = temp();
    const { b } = broker({ shotsDir: () => dir });
    void b.next(0);
    await new Promise((r) => setTimeout(r, 5));
    const plain = b.submit({ verb: 'screenshot' });
    await serve(b, () => ({ ok: true, data: { base64: PNG, width: 2, height: 2 } }));
    const shot = await plain;
    expect(shot).toMatchObject({ ok: true, data: { mime: 'image/png', width: 2 } });
    const path = (shot as { data: { path: string } }).data.path;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(shot)).not.toContain(PNG);
    const opted = b.submit({ verb: 'screenshot', includeImage: true });
    await serve(b, () => ({ ok: true, data: { base64: PNG } }));
    expect((await opted as { data: { base64?: string } }).data.base64).toBe(PNG);
  });

  it('times out when the window never answers', async () => {
    const { b } = broker({ timeoutMs: 20 });
    void b.next(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(await b.submit({ verb: 'snapshot' })).toMatchObject({ ok: false, code: 'timeout' });
  });
});

describe('self-surface endpoint', () => {
  it('publishes a 0600 loopback endpoint with a scoped token', () => {
    const home = temp();
    expect(publishSelfSurfaceEndpoint('http://0.0.0.0:7790', home)).toBeNull();
    const path = publishSelfSurfaceEndpoint('http://127.0.0.1:7790', home)!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const endpoint = readSelfSurfaceEndpoint(home)!;
    expect(endpoint.url).toBe('http://127.0.0.1:7790');
    expect(selfTokenMatches(endpoint.token)).toBe(true);
    expect(selfTokenMatches('0'.repeat(64))).toBe(false);
    expect(readFileSync(path, 'utf8')).toContain('phantom.self-surface.endpoint.v1');
  });
});
