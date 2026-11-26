import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSelfSurfaceApi } from '../src/core/verse/self-surface-api.js';
import { SelfSurfaceBroker, publishSelfSurfaceEndpoint, readSelfSurfaceEndpoint } from '../src/core/verse/self-surface.js';
import { runSelfCheck, sendSelfRequest } from '../src/core/verse/self-surface-agent.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'self-agent-')); cleanup.push(() => rmSync(r, { recursive: true, force: true })); return r; };

/** A console with the self-surface mounted and a fake window that answers with `window`. */
async function consoleWith(window: (request: Record<string, unknown>) => unknown, home: string) {
  const broker = new SelfSurfaceBroker({ postIntent: () => ({ status: 'posted' }), killed: () => false, commsPaused: () => false, timeoutMs: 2_000, shotsDir: () => join(home, 'shots') });
  const api = createSelfSurfaceApi(() => broker);
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '', 'http://x').pathname;
    void api({ token: 'console-token' } as never, req, res, path, req.method ?? 'GET').then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let live = true;
  cleanup.push(() => { live = false; });
  void (async () => {
    while (live) {
      const command = await broker.next(200);
      if (command) broker.complete(command.id, window(command.request as Record<string, unknown>));
    }
  })();
  await new Promise((r) => setTimeout(r, 10));
  publishSelfSurfaceEndpoint(url, home);
  return url;
}

describe('self-surface routes and agent', () => {
  it('refuses browser origins and wrong tokens, and answers the scoped token', async () => {
    const home = temp();
    const url = await consoleWith(() => ({ ok: true, data: { title: 'Phantom' } }), home);
    const post = (headers: Record<string, string>) => fetch(`${url}/api/verse/self/request`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"verb":"snapshot"}' });
    const token = readSelfSurfaceEndpoint(home)!.token;
    expect((await post({})).status).toBe(401);
    expect((await post({ 'x-ashlr-self-token': 'f'.repeat(64) })).status).toBe(401);
    expect((await post({ 'x-ashlr-self-token': token, origin: 'http://evil.test' })).status).toBe(403);
    expect(await (await post({ 'x-ashlr-self-token': token })).json()).toMatchObject({ ok: true, data: { title: 'Phantom' } });
    expect(await sendSelfRequest({ verb: 'snapshot' }, { home })).toMatchObject({ ok: true });
  });

  it('reports no console when nothing published an endpoint', async () => {
    expect(await sendSelfRequest({ verb: 'snapshot' }, { home: temp() })).toMatchObject({ ok: false, code: 'no_console' });
  });

  it('runs the self-check across screens, flags regressions and compares against a recorded baseline', async () => {
    const home = temp();
    let nodes = 100;
    const png = Buffer.from('89504e470d0a1a0a00', 'hex').toString('base64');
    let section = 'command';
    await consoleWith((request) => {
      if (request['verb'] === 'navigate') {
        section = String(request['section']);
        return { ok: true, data: { loadMs: section === 'fleet' ? 3_100 : 120, stillLoading: section === 'fleet', consoleErrors: section === 'mind' ? ['TypeError: x is undefined'] : [] } };
      }
      if (request['verb'] === 'screenshot') return { ok: true, data: { base64: png, width: 1, height: 1 } };
      return { ok: true, data: { route: { section }, nodeCount: nodes, scrollHeight: 900, overflowX: section === 'chat', nodes: [{ tag: 'main' }] } };
    }, home);
    const sections = ['command', 'fleet', 'mind', 'chat'];
    const first = await runSelfCheck({ home, sections, updateBaseline: true });
    expect(first).toMatchObject({ ok: false, baseline: 'recorded' });
    const flags = Object.fromEntries((first as { screens: Array<{ section: string; flags: string[]; screenshot: string | null }> }).screens.map((s) => [s.section, s.flags]));
    expect(flags['command']).toEqual([]);
    expect(flags['fleet']).toEqual(['slow load: 3100 ms', 'still loading when captured']);
    expect(flags['mind']).toEqual(['1 console error(s)']);
    expect(flags['chat']).toEqual(['horizontal overflow']);
    nodes = 300;
    const second = await runSelfCheck({ home, sections: ['command'] });
    expect(second).toMatchObject({ ok: false, baseline: 'compared', screens: [{ section: 'command', flags: ['node count 100 -> 300'] }] });
    expect((second as { screens: Array<{ screenshot: string | null }> }).screens[0]!.screenshot).toMatch(/\.png$/);
  });
});
