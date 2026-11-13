import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseVerseArgs } from '../src/cli/verse.js';
import { VERSE_MOBILE_SW_PATH } from '../src/core/web/static.js';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('legacy Phantom names retained across the rename', () => {
  it('keeps both executable names and the universe package export', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.bin).toMatchObject({ phm: 'bin/ashlr', ashlr: 'bin/ashlr' });
    expect(pkg.exports['./universe']).toEqual({
      types: './dist/core/universe/index.d.ts', import: './dist/core/universe/index.js',
    });
  });

  it('retains the verse flag and exit-code contract', () => {
    expect(parseVerseArgs(['--help'])).toEqual({ error: '', code: 0 });
    expect(parseVerseArgs(['--port', '7777', '--no-open', '--json'])).toMatchObject({ port: 7777, open: false, json: true });
    expect(parseVerseArgs(['--unknown'])).toMatchObject({ code: 2 });
    expect(parseVerseArgs(['--port', 'invalid'])).toMatchObject({ code: 2 });
  });

  it('retains the mobile install URL, scope and cache namespaces', () => {
    const manifest = JSON.parse(read('src/web-ui/public/verse-m/manifest.webmanifest'));
    expect(manifest).toMatchObject({ id: '/verse/m/', start_url: '/verse/m/', scope: '/verse/m/' });
    expect(VERSE_MOBILE_SW_PATH).toBe('/verse/m/sw.js');
    const worker = read('src/web-ui/public/verse-m/sw.js');
    expect(worker).toContain("var SHELL_CACHE = 'ashlr-verse-m-shell-' + VERSION;");
    expect(worker).toContain("var ASSET_CACHE = 'ashlr-verse-m-assets-' + VERSION;");
    expect(worker).toContain("var SHELL_URL = '/verse/m/';");
  });
});
