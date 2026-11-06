import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  handles: [] as Array<{ file: string; reads: Array<{ buffer: number; requested: number; received: number }>; closed: boolean }>,
  failRead: false,
  failStat: false,
  shortReads: false,
  readFileCalls: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: (...args: Parameters<typeof real.readFile>) => {
      io.readFileCalls++;
      return real.readFile(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const record = { file: String(args[0]), reads: [] as Array<{ buffer: number; requested: number; received: number }>, closed: false };
      io.handles.push(record);
      return {
        stat: () => io.failStat ? Promise.reject(new Error('injected stat error')) : handle.stat(),
        read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          if (io.failRead) throw new Error('injected read error');
          const result = await handle.read(buffer, offset, io.shortReads ? Math.min(length, 4096) : length, position);
          record.reads.push({ buffer: buffer.byteLength, requested: length, received: result.bytesRead });
          return result;
        },
        close: async () => { await handle.close(); record.closed = true; },
      };
    },
  };
});

import { EMPTY_STEERING, readWikiSteering } from '../src/core/knowledge/wiki/steering.js';

const LIMIT = 64 * 1024;
let repo: string;
const source = (name: 'ashlr' | 'devin') => path.join(repo, `.${name}`, 'wiki.json');
const digest = (ashlr: string, devin: string) => createHash('sha256').update(ashlr).update('\0').update(devin).digest('hex').slice(0, 16);

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'wiki-bounded-'));
  await mkdir(path.join(repo, '.ashlr'));
  await mkdir(path.join(repo, '.devin'));
  io.handles = [];
  io.failRead = false;
  io.failStat = false;
  io.shortReads = false;
  io.readFileCalls = 0;
});

afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('bounded wiki steering reads', () => {
  it('accepts exactly 64 KiB of UTF-8 bytes, including after short reads', async () => {
    const prefix = '{"notes":["é"],"localOnly":true}';
    const raw = prefix + ' '.repeat(LIMIT - Buffer.byteLength(prefix));
    await writeFile(source('ashlr'), raw);
    io.shortReads = true;
    const result = await readWikiSteering(repo);
    expect(result.notes).toEqual(['é']);
    expect(result.localOnly).toBe(true);
    expect(result.sources).toEqual(['.ashlr/wiki.json']);
    expect(result.hash).toBe(digest(raw, ''));
    expect(io.handles).toHaveLength(1);
    const handle = io.handles[0]!;
    expect(handle.closed).toBe(true);
    expect(handle.reads.length).toBeGreaterThan(2);
    expect(handle.reads.reduce((total, read) => total + read.received, 0)).toBe(LIMIT);
    expect(handle.reads.every((read) => read.buffer === LIMIT + 1 && read.requested <= LIMIT + 1)).toBe(true);
    expect(io.readFileCalls).toBe(0);
  });

  it('rejects one byte over the limit while retaining the other source', async () => {
    const raw = '{"localOnly":true}' + ' '.repeat(LIMIT + 1 - Buffer.byteLength('{"localOnly":true}'));
    const devin = '{"repo_notes":[{"content":"valid"}],"localOnly":true}';
    await writeFile(source('ashlr'), raw);
    await writeFile(source('devin'), devin);
    const result = await readWikiSteering(repo);
    expect(result.notes).toEqual(['valid']);
    expect(result.sources).toEqual(['.devin/wiki.json']);
    expect(result.localOnly).toBe(false);
    expect(result.hash).toBe(digest('', devin));
    expect(io.handles.every((handle) => handle.closed)).toBe(true);
    expect(io.handles.find((handle) => handle.file === source('ashlr'))!.reads.reduce((n, read) => n + read.received, 0)).toBe(LIMIT + 1);
  });

  it('reads at most limit plus one from a huge sparse regular file', async () => {
    const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const file = await open(source('ashlr'), 'w');
    try { await file.truncate(8 * 1024 * 1024 * 1024); } finally { await file.close(); }
    // Ignore fixture setup; measure only the public read.
    io.handles = [];
    const result = await readWikiSteering(repo);
    expect(result).toEqual(EMPTY_STEERING);
    expect(io.handles).toHaveLength(1);
    const handle = io.handles[0]!;
    expect(handle.closed).toBe(true);
    expect(handle.reads.reduce((n, read) => n + read.received, 0)).toBeLessThanOrEqual(LIMIT + 1);
    expect(handle.reads.every((read) => read.buffer <= LIMIT + 1 && read.requested <= LIMIT + 1)).toBe(true);
    expect(io.readFileCalls).toBe(0);
  });

  it('ignores malformed JSON, missing paths and directories, closing opened handles', async () => {
    await writeFile(source('ashlr'), '{invalid');
    await mkdir(source('devin'));
    expect(await readWikiSteering(repo)).toEqual(EMPTY_STEERING);
    expect(io.handles).toHaveLength(2);
    expect(io.handles.every((handle) => handle.closed)).toBe(true);
    expect(io.handles.find((handle) => handle.file === source('devin'))!.reads).toHaveLength(0);
    await rm(source('ashlr'));
    await rm(source('devin'), { recursive: true });
    io.handles = [];
    expect(await readWikiSteering(repo)).toEqual(EMPTY_STEERING);
    expect(io.handles).toHaveLength(0);
  });

  it('closes the handle and ignores a read error', async () => {
    await writeFile(source('ashlr'), '{}');
    io.failRead = true;
    expect(await readWikiSteering(repo)).toEqual(EMPTY_STEERING);
    expect(io.handles).toHaveLength(1);
    expect(io.handles[0]!.closed).toBe(true);
  });

  it('closes the handle and ignores a stat error', async () => {
    await writeFile(source('ashlr'), '{}');
    io.failStat = true;
    expect(await readWikiSteering(repo)).toEqual(EMPTY_STEERING);
    expect(io.handles).toHaveLength(1);
    expect(io.handles[0]!.closed).toBe(true);
    expect(io.handles[0]!.reads).toHaveLength(0);
  });

  it('preserves both-source hash, attribution, precedence and local-only restriction', async () => {
    const ashlr = '{ "include": ["core"], "notes": ["A"], "localOnly": true }\n';
    const devin = '{"repo_notes":[{"content":"D"}],"pages":[{"title":"Other"}],"localOnly":false}';
    await writeFile(source('ashlr'), ashlr);
    await writeFile(source('devin'), devin);
    const result = await readWikiSteering(repo);
    expect(result.include).toEqual(['core']);
    expect(result.notes).toEqual(['A', 'D']);
    expect(result.devinDefinesPages).toBe(false);
    expect(result.localOnly).toBe(true);
    expect(result.sources).toEqual(['.ashlr/wiki.json', '.devin/wiki.json']);
    expect(result.hash).toBe(digest(ashlr, devin));
    expect(io.handles.every((handle) => handle.closed)).toBe(true);
  });
});
