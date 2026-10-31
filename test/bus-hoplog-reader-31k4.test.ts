import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusHop, BUS_HOPLOG_MAX_BYTES, busHoplogPath } from '../src/core/fleet/bus-hoplog.js';
import { readBusHopsDetailed } from '../src/core/fleet/bus-hoplog-reader.js';

let root: string, file: string;
const hop = (id: string) => ({ id, from: 'sender', to: 'receiver', inputTokens: 3, outputTokens: null });
const line = (value: unknown) => JSON.stringify(value) + '\n';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-reader-'));
  file = join(root, 'hops.jsonl');
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function write(text: string): void { writeFileSync(file, text, { mode: 0o600 }); }

describe('bounded bus hop metadata reader', () => {
  it('reads writer output in file order and resolves the default path at call time', () => {
    expect(appendBusHop(hop('first'))).toBe(true);
    expect(appendBusHop(hop('second'))).toBe(true);
    expect(readBusHopsDetailed()).toEqual({ status: 'ok', hops: [hop('first'), hop('second')], invalidRows: 0,
      partialFinalRow: false, byteTruncated: false, rowTruncated: false, bytesRead: Buffer.byteLength(line(hop('first')) + line(hop('second'))) });
    expect(readBusHopsDetailed({ file: busHoplogPath() }).hops).toEqual([hop('first'), hop('second')]);
  });

  it('projects only validated fields, counts bad complete rows, and excludes a partial final row', () => {
    write(line({ ...hop('good'), body: 'PRIVATE-BODY', arbitrary: { nested: true } }) +
      'bad json\n' + line({ ...hop('invalid'), inputTokens: -1 }) + line(null) + line(hop('last')) + '{"id":"unfinished"');
    const result = readBusHopsDetailed({ file });
    expect(result.hops).toEqual([hop('good'), hop('last')]);
    expect(result.invalidRows).toBe(3);
    expect(result.partialFinalRow).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-BODY');
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('does not accept a valid-looking row without its terminating newline', () => {
    write(line(hop('complete')) + JSON.stringify(hop('pending')));
    expect(readBusHopsDetailed({ file })).toMatchObject({ hops: [hop('complete')], partialFinalRow: true, invalidRows: 0 });
  });

  it('returns the newest valid rows in source order and counts invalid rows across the scanned tail', () => {
    write(line(hop('a')) + 'invalid\n' + line(hop('b')) + line(hop('c')) + line(hop('d')));
    expect(readBusHopsDetailed({ file, maxRows: 2 })).toMatchObject({ hops: [hop('c'), hop('d')], invalidRows: 1,
      rowTruncated: true, byteTruncated: false });
  });

  it('bounds reads of a full-size log and detects a cut first row', () => {
    write('');
    truncateSync(file, BUS_HOPLOG_MAX_BYTES);
    const result = readBusHopsDetailed({ file, maxBytes: 128 });
    expect(result).toMatchObject({ status: 'ok', hops: [], byteTruncated: true, partialFinalRow: true, bytesRead: 128, invalidRows: 0 });
  });

  it('uses a boundary byte to retain a complete row when the byte window starts on its first byte', () => {
    const last = line(hop('last'));
    write(line(hop('first')) + last);
    const result = readBusHopsDetailed({ file, maxBytes: Buffer.byteLength(last) + 1 });
    expect(result).toMatchObject({ hops: [hop('last')], byteTruncated: true, partialFinalRow: false });
    expect(readBusHopsDetailed({ file, maxBytes: Buffer.byteLength(last) })).toMatchObject({ hops: [], byteTruncated: true });
  });

  it('distinguishes missing from unsafe or unreadable sources without exposing paths', () => {
    expect(readBusHopsDetailed({ file }).status).toBe('missing');
    const target = join(root, 'target');
    writeFileSync(target, line(hop('a')), { mode: 0o600 });
    symlinkSync(target, file);
    expect(readBusHopsDetailed({ file })).toEqual(expect.objectContaining({ status: 'unreadable', hops: [] }));
    rmSync(file);
    linkSync(target, file);
    expect(readBusHopsDetailed({ file }).status).toBe('unreadable');
    rmSync(file);
    mkdirSync(file);
    expect(readBusHopsDetailed({ file }).status).toBe('unreadable');
    rmSync(file, { recursive: true });
    write(line(hop('a')));
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644);
      expect(readBusHopsDetailed({ file }).status).toBe('unreadable');
    }
  });

  it('rejects invalid limits before reading', () => {
    for (const maxBytes of [0, 1, -1, 1.5, Infinity, BUS_HOPLOG_MAX_BYTES + 1]) {
      expect(() => readBusHopsDetailed({ file, maxBytes })).toThrow(RangeError);
    }
    for (const maxRows of [0, -1, 1.5, NaN, 10001]) {
      expect(() => readBusHopsDetailed({ file, maxRows })).toThrow(RangeError);
    }
  });
});
