/**
 * Regression coverage for built web console asset resolution under `npm run dev`
 * and 503/startup guidance before `npm run build:web` has run. Hermetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';
import { inspectConsoleAssets, missingConsoleAssetsResponseBody } from '../src/core/web/console-assets.js';
import { isConsoleShellPath } from '../src/core/web/static.js';
import { startServer } from '../src/core/web/server.js';

const makeConfig = (): AshlrConfig => ({
  version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: 'http://127.0.0.1:1', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
  telemetry: {}, tools: {},
});

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('inspectConsoleAssets', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-console-assets-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('resolves sibling public/next/index.html when running from compiled dist/', () => {
    const distServer = path.join(tmp, 'repo', 'dist', 'core', 'web', 'server.js');
    const distPublic = path.join(tmp, 'repo', 'dist', 'core', 'web', 'public');
    writeFile(distServer, '// compiled');
    writeFile(path.join(distPublic, 'next', 'index.html'), '<!doctype html><div id="root"></div>');

    expect(inspectConsoleAssets({ modulePath: distServer, env: {} })).toEqual({
      ready: true, source: 'sibling', sourceCheckout: false, dirs: [distPublic], fix: null,
    });
  });

  it('falls back to sibling dist/core/web/public when running from source checkout (npm run dev)', () => {
    const repo = path.join(tmp, 'repo');
    const srcServer = path.join(repo, 'src', 'core', 'web', 'server.ts');
    const srcPublic = path.join(repo, 'src', 'core', 'web', 'public');
    const distPublic = path.join(repo, 'dist', 'core', 'web', 'public');
    writeFile(srcServer, '// source');
    writeFile(path.join(srcPublic, 'index.html'), '<html>legacy</html>');
    writeFile(path.join(distPublic, 'next', 'index.html'), '<!doctype html><div id="root"></div>');

    expect(inspectConsoleAssets({ modulePath: srcServer, env: {} })).toEqual({
      ready: true, source: 'source-dist', sourceCheckout: true, dirs: [srcPublic, distPublic], fix: null,
    });
  });

  it('reports not ready with build:web fix in an unbuilt source checkout', () => {
    const repo = path.join(tmp, 'repo');
    const srcServer = path.join(repo, 'src', 'core', 'web', 'server.ts');
    const srcPublic = path.join(repo, 'src', 'core', 'web', 'public');
    writeFile(srcServer, '// source');
    writeFile(path.join(srcPublic, 'index.html'), '<html>legacy</html>');

    const status = inspectConsoleAssets({ modulePath: srcServer, env: {} });
    expect(status).toMatchObject({ ready: false, source: null, sourceCheckout: true, dirs: [srcPublic] });
    expect(status.fix).toContain('npm run build:web');
    const body = missingConsoleAssetsResponseBody(status);
    expect(body).toContain('npm run build:web');
    expect(body).toContain('npm run build');
    expect(body).not.toContain(tmp);
  });

  it('treats ASHLR_WEB_PUBLIC as authoritative and never falls back to repo dist/', () => {
    const repo = path.join(tmp, 'repo');
    const srcServer = path.join(repo, 'src', 'core', 'web', 'server.ts');
    const distPublic = path.join(repo, 'dist', 'core', 'web', 'public');
    const customPublic = path.join(tmp, 'sidecar-public');
    writeFile(srcServer, '// source');
    writeFile(path.join(distPublic, 'next', 'index.html'), '<!doctype html>repo-dist');
    fs.mkdirSync(customPublic, { recursive: true });

    const missing = inspectConsoleAssets({ modulePath: srcServer, env: { ASHLR_WEB_PUBLIC: customPublic } });
    expect(missing).toMatchObject({ ready: false, source: null, dirs: [customPublic] });
    expect(missing.fix).toContain('ASHLR_WEB_PUBLIC');
    const missingBody = missingConsoleAssetsResponseBody(missing);
    expect(missingBody).toContain('ASHLR_WEB_PUBLIC');
    expect(missingBody).not.toContain(tmp);

    writeFile(path.join(customPublic, 'next', 'index.html'), '<!doctype html>sidecar');
    expect(inspectConsoleAssets({ modulePath: srcServer, env: { ASHLR_WEB_PUBLIC: customPublic } })).toEqual({
      ready: true, source: 'override', sourceCheckout: true, dirs: [customPublic], fix: null,
    });
  });

  it('rejects symlinked dist/core/web/public or next/index.html', () => {
    const repo = path.join(tmp, 'repo');
    const outside = path.join(tmp, 'outside');
    const srcServer = path.join(repo, 'src', 'core', 'web', 'server.ts');
    const srcPublic = path.join(repo, 'src', 'core', 'web', 'public');
    writeFile(srcServer, '// source');
    writeFile(path.join(srcPublic, 'index.html'), '<html>legacy</html>');
    writeFile(path.join(outside, 'next', 'index.html'), '<!doctype html>escaped');

    const distWeb = path.join(repo, 'dist', 'core', 'web');
    fs.mkdirSync(distWeb, { recursive: true });
    fs.symlinkSync(outside, path.join(distWeb, 'public'), 'junction');
    expect(inspectConsoleAssets({ modulePath: srcServer, env: {} })).toMatchObject({ ready: false, dirs: [srcPublic] });

    fs.unlinkSync(path.join(distWeb, 'public'));
    const realDistNext = path.join(distWeb, 'public', 'next');
    fs.mkdirSync(realDistNext, { recursive: true });
    try {
      fs.symlinkSync(path.join(outside, 'next', 'index.html'), path.join(realDistNext, 'index.html'));
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    expect(inspectConsoleAssets({ modulePath: srcServer, env: {} })).toMatchObject({ ready: false, dirs: [srcPublic] });
  });
});

describe('isConsoleShellPath', () => {
  it('matches all console and phone shell entry paths and rejects lookalikes', () => {
    for (const p of ['/verse', '/verse/', '/app', '/app/', '/next', '/next/', '/verse/m', '/verse/m/', '/app/m', '/app/m/', '/verse/owner-assist', '/verse/owner-assist/']) {
      expect(isConsoleShellPath(p), p).toBe(true);
    }
    for (const p of ['/', '/api/health', '/verse/m/sw.js', '/verse/m/agents', '/application', '/next/assets/a.js']) {
      expect(isConsoleShellPath(p), p).toBe(false);
    }
  });
});

describe('startServer console asset serving and 503 guidance', () => {
  let tmp: string;
  let prevPublic: string | undefined;
  let handle: WebServerHandle | null = null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-server-assets-'));
    prevPublic = process.env.ASHLR_WEB_PUBLIC;
    writeFile(path.join(tmp, 'index.html'), '<html>legacy-root</html>');
    process.env.ASHLR_WEB_PUBLIC = tmp;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle) { await handle.close(); handle = null; }
    if (prevPublic === undefined) delete process.env.ASHLR_WEB_PUBLIC;
    else process.env.ASHLR_WEB_PUBLIC = prevPublic;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 503 with build guidance on console shells when unbuilt, then serves 200 once built', async () => {
    handle = await startServer(makeConfig(), { port: 0, open: false, allowDispatch: false }, { readProjections: null });

    const rootRes = await fetch(`${handle.url}/`, { signal: AbortSignal.timeout(2000) });
    expect(rootRes.status).toBe(200);
    expect(await rootRes.text()).toContain('legacy-root');

    for (const route of ['/verse/', '/app/', '/next/', '/verse/m/']) {
      const res = await fetch(`${handle.url}${route}`, { signal: AbortSignal.timeout(2000) });
      expect(res.status, route).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.text();
      expect(body).toContain('npm run build:web');
      expect(body).not.toContain(tmp);
      expect(body).not.toContain(handle.readToken);
      expect(body).not.toContain(handle.token);
    }

    const headRes = await fetch(`${handle.url}/verse/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    expect(headRes.status).toBe(503);
    expect(await headRes.text()).toBe('');

    expect((await fetch(`${handle.url}/does-not-exist`, { signal: AbortSignal.timeout(2000) })).status).toBe(404);

    writeFile(path.join(tmp, 'next', 'index.html'), '<!doctype html><div id="root">built</div>');
    writeFile(path.join(tmp, 'next', 'assets', 'app-12345678.js'), 'console.log("ok");');

    for (const route of ['/verse/', '/app/', '/next/', '/verse/m/']) {
      const res = await fetch(`${handle.url}${route}`, { signal: AbortSignal.timeout(2000) });
      expect(res.status, route).toBe(200);
      expect(await res.text()).toContain('built');
    }
    const assetRes = await fetch(`${handle.url}/next/assets/app-12345678.js`, { signal: AbortSignal.timeout(2000) });
    expect(assetRes.status).toBe(200);
    expect(await assetRes.text()).toContain('console.log("ok")');
  });

  it('never returns 404 for /verse/ without ASHLR_WEB_PUBLIC (200 when dist web bundle exists, 503 otherwise)', async () => {
    delete process.env.ASHLR_WEB_PUBLIC;
    const expected = inspectConsoleAssets({ env: process.env });
    handle = await startServer(makeConfig(), { port: 0, open: false, allowDispatch: false }, { readProjections: null });

    const res = await fetch(`${handle.url}/verse/`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(expected.ready ? 200 : 503);
    const body = await res.text();
    expect(expected.ready ? body.toLowerCase() : body).toContain(expected.ready ? '<!doctype html>' : 'npm run build:web');
  });
});
