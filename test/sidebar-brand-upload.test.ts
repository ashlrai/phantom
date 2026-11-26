import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdSettings } from '../src/cli/settings-appearance.js';
import { MAX_BRAND_BYTES, readBrandImage, sanitizeBrandImage } from '../src/core/brand/sidebar-upload.js';
import { defaultConfig } from '../src/core/config.js';
import { VERSE_BRAND_IMAGE_PATH } from '../src/core/verse/ui-appearance-api.js';
import { readUiAppearanceFile } from '../src/core/verse/ui-appearance-file.js';
import { startServer } from '../src/core/web/server.js';

const svg = Buffer.from('<svg viewBox="0 0 24 24"><path d="M0 0h24v24z" fill="red"/></svg>');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sidebar-brand-'));
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('sidebar brand images', () => {
  it('retains safe geometry and fragment references but strips active and external content', () => {
    const image = sanitizeBrandImage(Buffer.from(`<?xml version="1.0"?>
      <svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" onload="run()">
        <defs><linearGradient id="paint"><stop offset="1" stop-color="red"/></linearGradient></defs>
        <path id="shape" d="M0 0h24v24z" fill="url(#paint)" stroke="url(https://example.com/track)" style="fill:url(//example.com/track)"/>
        <use xlink:href="&#35;shape"/><use href="https://example.com/mark.svg#shape"/>
        <script><![CDATA[run()]]></script><foreignObject><p>hidden</p></foreignObject>
        <style>@import 'https://example.com/track';</style><image href="data:image/svg+xml,unsafe"/>
      </svg>`));
    const clean = image.bytes.toString();
    expect(image.contentType).toBe('image/svg+xml');
    expect(clean).toContain('<path id="shape" d="M0 0h24v24z" fill="url(#paint)"/>');
    expect(clean).toContain('<use href="#shape"/>');
    expect(clean).not.toMatch(/script|foreignObject|onload|style=|example\.com|hidden|data:/i);
    expect(sanitizeBrandImage(image.bytes).bytes).toEqual(image.bytes);
  });

  it('rejects unsupported formats, malformed markup, declarations and oversize files', () => {
    for (const text of ['GIF89a', '<svg><path></svg>', '<!DOCTYPE svg><svg/>', '<svg/><?xml-stylesheet href="external"?>', '<svg/><svg/>']) {
      expect(() => sanitizeBrandImage(Buffer.from(text))).toThrow(/SVG/);
    }
    expect(() => sanitizeBrandImage(Buffer.alloc(MAX_BRAND_BYTES + 1))).toThrow(/512 KB/);
  });

  it('recognizes PNG and WebP by their bytes', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA2sAAAAASUVORK5CYII=', 'base64');
    const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64').subarray(0, 42);
    expect(sanitizeBrandImage(png)).toEqual({ contentType: 'image/png', bytes: png });
    expect(sanitizeBrandImage(webp)).toEqual({ contentType: 'image/webp', bytes: webp });
  });

  it('round-trips built-in and uploaded marks with the existing CLI and resets to P', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = join(dir, 'brand.svg');
    await writeFile(path, svg);
    expect(await cmdSettings(['appearance', 'set', '--brand', 'ghost', '--json'])).toBe(0);
    expect((await readUiAppearanceFile())?.appearance.brand).toBe('ghost');
    expect(await cmdSettings(['appearance', 'set', '--brand-file', path, '--theme', 'dark', '--json'])).toBe(0);
    const appearance = (await readUiAppearanceFile())?.appearance;
    expect(appearance).toMatchObject({ brand: 'upload', theme: 'dark' });
    expect(await readBrandImage(appearance!.brandAsset!)).toEqual(sanitizeBrandImage(svg));
    expect(await cmdSettings(['appearance', 'get', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0])).appearance.brand).toBe('upload');
    expect(await cmdSettings(['appearance', '--reset', '--json'])).toBe(0);
    expect((await readUiAppearanceFile())?.appearance).toMatchObject({ brand: 'p', theme: 'system' });
    expect((await readUiAppearanceFile())?.appearance).not.toHaveProperty('brandAsset');
  });

  it('serves the selected image only through the authenticated local server', async () => {
    const server = await startServer(defaultConfig(), { port: 0, open: false, allowDispatch: true }, { readProjections: null });
    try {
      const url = server.url + VERSE_BRAND_IMAGE_PATH;
      const read = { 'x-ashlr-token': server.readToken };
      const write = { 'x-ashlr-token': server.token };
      expect((await fetch(url, { headers: read })).status).toBe(404);
      expect((await fetch(url, { method: 'POST', headers: read, body: svg.toString('base64') })).status).toBe(401);
      const upload = await fetch(url, { method: 'POST', headers: write, body: svg.toString('base64') });
      expect(upload.status).toBe(200);
      const appearance = (await readUiAppearanceFile())?.appearance;
      expect(appearance?.brandAsset).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(await upload.json()).toMatchObject({ appearance });
      const shared = await fetch(server.url + '/api/verse/appearance', { headers: read });
      expect(await shared.json()).toMatchObject({ appearance });
      expect((await fetch(url)).status).toBe(401);
      const image = await fetch(url, { headers: read });
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/svg+xml');
      expect(image.headers.get('content-security-policy')).toContain('sandbox');
      expect(Buffer.from(await image.arrayBuffer())).toEqual(sanitizeBrandImage(svg).bytes);
    } finally {
      await server.close();
    }
  });
});
