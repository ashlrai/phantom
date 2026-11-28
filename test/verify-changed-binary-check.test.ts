import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, crc32, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { binaryAssetError, runBinaryAssetCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function makePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeJpeg(withScan = true): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const scan = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
  const tail = withScan ? Buffer.concat([sos, scan, Buffer.from([0xff, 0xd9])]) : Buffer.from([0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, tail]);
}

function makeWebp(): Buffer {
  const vp8x = Buffer.concat([Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0]), Buffer.alloc(10)]);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x]);
  const riff = Buffer.alloc(4);
  riff.writeUInt32LE(body.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), riff, body]);
}

function makeIco(payload: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 0); // width
  entry.writeUInt16LE(1, 1); // height
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(payload.length, 8);
  entry.writeUInt32LE(22, 12); // offset: 6 + 16
  return Buffer.concat([header, entry, payload]);
}

function makeIcns(): Buffer {
  const element = Buffer.concat([Buffer.from('icp4', 'latin1'), (() => { const l = Buffer.alloc(4); l.writeUInt32BE(12, 0); return l; })(), Buffer.alloc(4)]);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + element.length, 4);
  return Buffer.concat([head, element]);
}

function makeHeadTable(): Buffer {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0); // version
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  return head;
}

function makeTtf(): Buffer {
  const head = makeHeadTable();
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4); // numTables
  const record = Buffer.alloc(16);
  record.write('head', 0, 'latin1');
  record.writeUInt32BE(0, 4); // checksum (unchecked)
  record.writeUInt32BE(28, 8); // offset: 12 + 16
  record.writeUInt32BE(head.length, 12);
  return Buffer.concat([header, record, head]);
}

function makeWoff(): Buffer {
  const header = Buffer.alloc(44);
  header.write('wOFF', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4); // flavor
  header.writeUInt32BE(44, 8); // length
  header.writeUInt16BE(0, 12); // numTables
  header.writeUInt32BE(100, 16); // totalSfntSize
  return header;
}

function makeWoff2(uncompressed = 100): Buffer {
  const data = Buffer.alloc(uncompressed, 0x61);
  const compressed = brotliCompressSync(data);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(0, 8); // length patched below
  header.writeUInt16BE(1, 12); // numTables
  header.writeUInt32BE(200, 16); // totalSfntSize
  header.writeUInt32BE(compressed.length, 20); // totalCompressedSize
  // directory: flags=0x01 (known tag 'head', transformVersion 0 -> untransformed), origLength base128
  const orig = Buffer.from([uncompressed & 0x7f]); // uncompressed < 128
  const body = Buffer.concat([header, Buffer.from([0x01]), orig, compressed]);
  body.writeUInt32BE(body.length, 8);
  return body;
}

describe('selectChangedFiles binary asset coverage', () => {
  it('selects existing binary assets and skips deleted, fixture and near-miss paths', () => {
    const selection = selectChangedFiles(
      [
        'docs/images/demo.png', 'desktop/src-tauri/icons/icon.ico', 'site/assets/font.woff2',
        'src/web-ui/design/fonts/SpaceGrotesk.ttf', 'pack.tar.gz', 'src/core/x.ts',
        'gone.png', 'test/fixtures/bad.png', 'notes.png.md', 'image.png.exe', 'font.WOFF2',
      ],
      [
        'docs/images/demo.png', 'desktop/src-tauri/icons/icon.ico', 'site/assets/font.woff2',
        'src/web-ui/design/fonts/SpaceGrotesk.ttf', 'pack.tar.gz', 'src/core/x.ts',
        'test/fixtures/bad.png', 'notes.png.md', 'image.png.exe', 'font.WOFF2',
      ],
    );
    expect(selection.binaryFiles).toEqual([
      'desktop/src-tauri/icons/icon.ico',
      'docs/images/demo.png',
      'font.WOFF2',
      'pack.tar.gz',
      'site/assets/font.woff2',
      'src/web-ui/design/fonts/SpaceGrotesk.ttf',
    ]);
  });
});

describe('binaryAssetError', () => {
  it('accepts minimal valid containers of every supported format', () => {
    const fixtures: Array<[string, Buffer]> = [
      ['a.png', makePng()],
      ['a.jpg', makeJpeg()],
      ['a.jpeg', makeJpeg(false)],
      ['a.webp', makeWebp()],
      ['a.ico', makeIco(makePng())],
      ['a.cur', makeIco((() => { const dib = Buffer.alloc(44); dib.writeUInt32BE(40, 0); return dib; })())],
      ['a.icns', makeIcns()],
      ['a.ttf', makeTtf()],
      ['a.otf', makeTtf()],
      ['a.woff', makeWoff()],
      ['a.woff2', makeWoff2()],
      ['a.gz', gzipSync(Buffer.from('payload'))],
    ];
    for (const [path, data] of fixtures) {
      expect(binaryAssetError(data, path), path).toBeNull();
    }
  });

  it('rejects truncated and corrupt containers', () => {
    const png = makePng();
    expect(binaryAssetError(Buffer.from('not a png'), 'x.png')).toContain('signature');
    expect(binaryAssetError(png.subarray(0, png.length - 4), 'x.png')).toContain('IEND');
    const badCrc = Buffer.from(png);
    badCrc[png.length - 13] ^= 0xff;
    expect(binaryAssetError(badCrc, 'x.png')).toContain('CRC');
    expect(binaryAssetError(Buffer.from([0xff, 0xd8, 0x00, 0x00]), 'x.jpg')).toContain('marker');
    expect(binaryAssetError(Buffer.from('RIFF\x00\x00\x00\x00WAVE'), 'x.webp')).toContain('WEBP');
    expect(binaryAssetError(Buffer.from('garbage-data-here!!'), 'x.ico')).toContain('reserved');
    expect(binaryAssetError(Buffer.from('garbage-data-here!!'), 'x.icns')).toContain('magic');
    const ttf = makeTtf();
    expect(binaryAssetError(ttf.subarray(0, 20), 'x.ttf')).toContain('directory');
    const woff2 = makeWoff2();
    expect(binaryAssetError(woff2.subarray(0, woff2.length - 1), 'x.woff2')).toContain('length');
    expect(binaryAssetError(Buffer.from('garbage'), 'x.gz')).toContain('gunzip');
  });

  it('names a file with no registered checker instead of passing it', () => {
    expect(binaryAssetError(Buffer.alloc(4), 'x.bmp')).toContain('no checker');
  });
});

describe('runBinaryAssetCheck', () => {
  it('passes valid files and fails every corrupt file in one pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-binary-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.png'), makePng());
      writeFileSync(join(root, 'ok.woff2'), makeWoff2());
      writeFileSync(join(root, 'bad.png'), Buffer.from('definitely not a png'));
      writeFileSync(join(root, 'bad.jpg'), Buffer.from([0xff, 0xd8, 0x01, 0x02]));
      expect(runBinaryAssetCheck(root, ['ok.png', 'ok.woff2', 'bad.png', 'bad.jpg'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.startsWith('FAIL binary asset check: bad.png:'))).toBe(true);
      expect(reported.some((line) => line.startsWith('FAIL binary asset check: bad.jpg:'))).toBe(true);
      expect(reported.every((line) => line.startsWith('FAIL binary asset check: '))).toBe(true);
      errors.mockClear();
      expect(runBinaryAssetCheck(root, ['ok.png', 'ok.woff2'])).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a file cannot be read and passes an empty list', () => {
    const read = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(runBinaryAssetCheck('/repo', ['locked.png'], read as never)).toBe(false);
    expect(runBinaryAssetCheck('/repo', [], read as never)).toBe(true);
  });

  it('parses every committed binary asset the repo ships', () => {
    const assets = [
      'docs/images/phantom-agent-world-3.24.3-demo.jpg',
      'src/web-ui/routes/verse/sections/assets/ash-coffee.webp',
      'desktop/src-tauri/icons/icon.ico',
      'desktop/src-tauri/icons/icon.icns',
      'desktop/src-tauri/icons/32x32.png',
      'src/web-ui/design/fonts/IBMPlexSans.ttf',
      'src/web-ui/design/fonts/SpaceGrotesk.ttf',
      'src/web-ui/design/fonts/AshlrSans-latin.woff2',
      'src/web-ui/design/fonts/IBMPlexSans-full.woff2',
      'src/web-ui/design/fonts/SpaceGrotesk-full.woff2',
      'src/web-ui/design/fonts/SpaceGrotesk-latin.woff2',
      'examples/universe-site/public/fonts/IBMPlexSans.ttf',
      'examples/universe-site/public/fonts/SpaceGrotesk.ttf',
    ];
    expect(runBinaryAssetCheck(process.cwd(), assets)).toBe(true);
  });
});
