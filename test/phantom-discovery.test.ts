import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/core/web/server.js';
import { generatePhantomClient, phantomManifest } from '../src/core/web/phantom-discovery.js';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';

const oldFlag = process.env.ASHLR_PHANTOM_DISCOVERY;
afterEach(() => { if (oldFlag === undefined) delete process.env.ASHLR_PHANTOM_DISCOVERY; else process.env.ASHLR_PHANTOM_DISCOVERY = oldFlag; });

describe('Phantom discovery', () => {
  it('is opt-in, authenticated, and generates a working typed client', async () => {
    const server = await startServer({} as AshlrConfig, { port: 0, allowDispatch: false } as WebServerOptions, { readProjections: null });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { 'x-ashlr-token': server.readToken };
    const dir = mkdtempSync(join(tmpdir(), 'phantom-client-'));
    try {
      delete process.env.ASHLR_PHANTOM_DISCOVERY;
      expect((await fetch(`${base}/api/phantom/discovery`, { headers })).status).toBe(404);
      process.env.ASHLR_PHANTOM_DISCOVERY = '1';
      expect((await fetch(`${base}/api/phantom/discovery`)).status).toBe(401);
      expect((await fetch(`${base}/api/phantom/ping`)).status).toBe(401);
      const manifest: unknown = await (await fetch(`${base}/api/phantom/discovery`, { headers })).json();
      expect(manifest).toEqual(phantomManifest);
      expect(() => generatePhantomClient({ ...phantomManifest, version: 2 })).toThrow();
      const source = generatePhantomClient(manifest);
      writeFileSync(join(dir, 'client.ts'), source);
      execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', join(dir, 'client.ts'), '--target', 'ES2022', '--module', 'ES2022', '--skipLibCheck', '--outDir', dir]);
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      const generated = await import(pathToFileURL(join(dir, 'client.js')).href) as { PhantomClient: new (url: string, token: string) => { ping(): Promise<{ ok: boolean }> } };
      expect(await new generated.PhantomClient(base, server.readToken).ping()).toEqual({ ok: true });
      await expect(new generated.PhantomClient(base, 'wrong').ping()).rejects.toThrow('401');
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
