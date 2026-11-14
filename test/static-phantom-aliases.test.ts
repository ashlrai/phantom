/**
 * RQ-RENAME-ALIASES-1 — the Phantom `/app` URLs alias the legacy `/verse`
 * URLs in serveStatic, byte for byte, and the legacy URLs are unchanged.
 * Hermetic: a temp assets dir, no server, no HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPhoneShellPath, serveStatic, VERSE_MOBILE_SW_PATH } from '../src/core/web/static.js';

let dir: string;
const SHELL = '<html><div id="root"></div></html>';
const MANIFEST = '{"scope":"/verse/m/"}';
const ICON = 'png-bytes';
const SW = 'self.skipWaiting();';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-aliases-'));
  fs.mkdirSync(path.join(dir, 'next', 'verse-m'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'next', 'index.html'), SHELL);
  fs.writeFileSync(path.join(dir, 'next', 'verse-m', 'manifest.webmanifest'), MANIFEST);
  fs.writeFileSync(path.join(dir, 'next', 'verse-m', 'icon-192.png'), ICON);
  fs.writeFileSync(path.join(dir, 'next', 'verse-m', 'sw.js'), SW);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function get(url: string): { handled: boolean; status: number; body: string; headers: Record<string, string> } {
  const out = { status: 200, body: '', headers: {} as Record<string, string> };
  const req = { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
  const res = {
    statusCode: 200,
    writeHead(code: number, headers?: Record<string, string>) { out.status = code; Object.assign(out.headers, headers); },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; },
    write(c: Buffer | string) { out.body += c.toString(); return true; },
    end(c?: Buffer | string) { if (c) out.body += c.toString(); },
  } as unknown as ServerResponse;
  return { handled: serveStatic(req, res, dir), ...out };
}

describe('Phantom /app aliases (static)', () => {
  it.each([
    ['/verse', '/app'], ['/verse/', '/app/'], ['/verse/m', '/app/m'], ['/verse/m/', '/app/m/'],
  ])('%s and %s serve the same shell', (legacy, alias) => {
    const a = get(legacy);
    const b = get(alias);
    expect(a.handled).toBe(true);
    expect(b.handled).toBe(true);
    expect(a.body).toBe(SHELL);
    expect(b.body).toBe(a.body);
    expect(b.headers['cache-control']).toBe(a.headers['cache-control']);
  });

  it.each(['manifest.webmanifest', 'icon-192.png'])('/next/app-m/%s serves the /next/verse-m/ bytes', (file) => {
    const legacy = get(`/next/verse-m/${file}`);
    const alias = get(`/next/app-m/${file}`);
    expect(legacy.handled).toBe(true);
    expect(alias.handled).toBe(true);
    expect(alias.body).toBe(legacy.body);
    expect(alias.headers['content-type']).toBe(legacy.headers['content-type']);
  });

  it('keeps the service worker at its legacy scope and adds no alias worker', () => {
    expect(VERSE_MOBILE_SW_PATH).toBe('/verse/m/sw.js');
    expect(get('/verse/m/sw.js').body).toBe(SW);
    expect(get('/app/m/sw.js').handled).toBe(false);
  });

  it('does not alias lookalikes or traversal', () => {
    for (const url of ['/application', '/app/x', '/app/m/x', '/app/mobile']) {
      expect(get(url).body, url).not.toBe(SHELL);
    }
    // An encoded slash survives URL parsing and decodes to `..` after the
    // alias prefix; the containment check must still refuse the escape.
    fs.writeFileSync(path.join(path.dirname(dir), `${path.basename(dir)}-secret.txt`), 'SECRET');
    try {
      for (const url of [`/next/app-m/..%2f..%2f..%2f${path.basename(dir)}-secret.txt`, '/next/app-m/..%2f..%2findex.html']) {
        const r = get(url);
        expect(r.handled, url).toBe(false);
        expect(r.body, url).not.toContain('SECRET');
      }
    } finally {
      fs.rmSync(path.join(path.dirname(dir), `${path.basename(dir)}-secret.txt`), { force: true });
    }
  });

  it('isPhoneShellPath covers both names and nothing else', () => {
    for (const p of ['/verse/m', '/verse/m/', '/app/m', '/app/m/']) expect(isPhoneShellPath(p)).toBe(true);
    for (const p of ['/verse', '/app', '/app/', '/app/m/sw.js', '/']) expect(isPhoneShellPath(p)).toBe(false);
  });
});
