import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBusHopsDetailed } from '../src/core/fleet/bus-hoplog-reader.js';

let root: string, file: string;
const hop = (id: string) => ({ id, from: 'sender', to: 'receiver', inputTokens: 3, outputTokens: null });
const row = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...hop(id), ...extra });
const bytes = (text: string) => Buffer.from(text, 'utf8');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-utf8-'));
  file = join(root, 'hops.jsonl');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(data: Buffer): void { writeFileSync(file, data, { mode: 0o600 }); }
function malformed(invalid: number[], ending = '\n'): Buffer {
  const [before, after] = row('bad', { ignored: 'MARKER' }).split('MARKER');
  return Buffer.concat([bytes(before!), Buffer.from(invalid), bytes(after! + ending)]);
}

describe('strict UTF-8 bus hop rows', () => {
  it('rejects malformed complete rows even in ignored fields, then continues to valid rows', () => {
    const data = Buffer.concat([
      bytes(row('first') + '\n'),
      malformed([0xff]), malformed([0xc0, 0xaf]), malformed([0xed, 0xa0, 0x80]),
      malformed([0xe2, 0x82], '\r\n'),
      bytes(row('last', { ignored: 'café 雪 🐈 �' }) + '\r\n'),
    ]);
    write(data);
    expect(readBusHopsDetailed({ file })).toEqual({
      status: 'ok', hops: [hop('first'), hop('last')], invalidRows: 4,
      partialFinalRow: false, byteTruncated: false, rowTruncated: false, bytesRead: data.length,
    });
  });

  it('excludes a leading row when the read boundary cuts a multibyte character', () => {
    const first = bytes(row('cut', { ignored: 'before🐈after' }) + '\n');
    const suffix = Buffer.concat([malformed([0xff]), bytes(row('following', { ignored: '雪' }) + '\r\n')]);
    const data = Buffer.concat([first, suffix]);
    write(data);
    const character = first.indexOf(bytes('🐈'));
    for (const split of [1, 2, 3]) {
      const maxBytes = data.length - character - split;
      expect(readBusHopsDetailed({ file, maxBytes })).toEqual({
        status: 'ok', hops: [hop('following')], invalidRows: 1,
        partialFinalRow: false, byteTruncated: true, rowTruncated: false, bytesRead: maxBytes,
      });
    }
  });

  it('keeps a complete non-ASCII row when the boundary probe is its preceding newline', () => {
    const last = bytes(row('last', { ignored: '雪🐈' }) + '\r\n');
    write(Buffer.concat([bytes(row('earlier') + '\n'), last]));
    expect(readBusHopsDetailed({ file, maxBytes: last.length + 1 })).toEqual({
      status: 'ok', hops: [hop('last')], invalidRows: 0,
      partialFinalRow: false, byteTruncated: true, rowTruncated: false, bytesRead: last.length + 1,
    });
  });

  it('excludes an incomplete final row containing malformed bytes without counting it', () => {
    const data = Buffer.concat([bytes(row('good') + '\n'), malformed([0xff], '')]);
    write(data);
    expect(readBusHopsDetailed({ file })).toEqual({
      status: 'ok', hops: [hop('good')], invalidRows: 0,
      partialFinalRow: true, byteTruncated: false, rowTruncated: false, bytesRead: data.length,
    });
  });

  it('preserves JSON rejection of a leading UTF-8 byte order mark', () => {
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(row('bom') + '\n' + row('next') + '\n')]);
    write(data);
    expect(readBusHopsDetailed({ file })).toEqual({
      status: 'ok', hops: [hop('next')], invalidRows: 1,
      partialFinalRow: false, byteTruncated: false, rowTruncated: false, bytesRead: data.length,
    });
  });

  it('counts malformed rows independently of the valid-row cap', () => {
    const data = Buffer.concat([bytes(row('first') + '\n'), malformed([0x80]), bytes(row('last') + '\n')]);
    write(data);
    expect(readBusHopsDetailed({ file, maxRows: 1 })).toEqual({
      status: 'ok', hops: [hop('last')], invalidRows: 1,
      partialFinalRow: false, byteTruncated: false, rowTruncated: true, bytesRead: data.length,
    });
  });
});
