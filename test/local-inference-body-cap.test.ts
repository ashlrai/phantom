/**
 * Local inference probes refuse an oversized body. The cap is enforced on
 * the stream, so a multi-megabyte reply is not buffered into the result.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeEndpoint } from '../src/core/providers.js';
import { LOCAL_PROBE_MAX_BODY_BYTES } from '../src/core/run/local-inference-probe.js';

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
  servers = [];
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('local inference probe body cap', () => {
  it('refuses a chunked body larger than the cap and does not echo it', async () => {
    const base = await serve((_req, res) => {
      res.on('error', () => { /* client stopped at the cap */ });
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const write = (): void => {
        if (res.destroyed || sent >= LOCAL_PROBE_MAX_BODY_BYTES + chunk.length) { res.end(); return; }
        sent += chunk.length;
        try {
          if (!res.write(chunk)) res.once('drain', write);
          else setImmediate(write);
        } catch { /* client stopped at the cap */ }
      };
      write();
    });
    const out = await probeEndpoint('lmstudio', `${base}/v1/models`);
    expect(out.up).toBe(false);
    expect(out.models).toEqual([]);
    expect(out.error).toBe('response body exceeded byte limit');
    expect(out.error).not.toContain('aaaa');
  });

  it('refuses a declared content-length over the cap without reading the payload', async () => {
    let bytesRead = 0;
    const base = await serve((req, res) => {
      req.on('data', (chunk: Buffer) => { bytesRead += chunk.length; });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(LOCAL_PROBE_MAX_BODY_BYTES + 1),
      });
      res.end('{"data":[{"id":"should-not-surface"}]}');
    });
    const out = await probeEndpoint('ollama', base);
    expect(out.up).toBe(false);
    expect(out.error).toBe('response body exceeded byte limit');
    expect(out.models).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('should-not-surface');
    expect(bytesRead).toBe(0);
  });
});
