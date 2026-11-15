import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJobRows, type JobLogIo } from '../src/core/fabric/lane-usage-self-io.js';
import { parseJobRows } from '../src/core/fabric/lane-usage-self.js';

const CAP = 4 * 1024 * 1024;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usage-log-bounded-'));
  await mkdir(join(dir, 'metrics'), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const put = (text: string): Promise<void> => writeFile(join(dir, 'metrics', 'jobs.jsonl'), text);
const row = (i: number, pad = 0): string =>
  JSON.stringify({ event: 'finish', lane: 'claude', ts: '2026-11-01T00:00:00Z', tokens_total: i, note: 'x'.repeat(pad) });

/** Spy seam over the real open(): records every read request and whether it was shorter than asked. */
function spyIo(maxChunk = Infinity): { io: JobLogIo; reads: number[]; closed: () => boolean } {
  const reads: number[] = []; let closed = false;
  const io: JobLogIo = {
    open: (async (...args: Parameters<typeof open>) => {
      const fh = await open(...args);
      const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>;
      const close = fh.close.bind(fh);
      (fh as unknown as { read: unknown }).read = (buf: Buffer, off: number, len: number, pos: number) => {
        reads.push(len);
        return read(buf, off, Math.min(len, maxChunk), pos);
      };
      (fh as unknown as { readFile: unknown }).readFile = () => { throw new Error('whole-file read'); };
      fh.close = async () => { closed = true; return close(); };
      return fh;
    }) as typeof open,
  };
  return { io, reads, closed: () => closed };
}

describe('readJobRows bounded read', () => {
  it('returns all rows of a small log and skips malformed lines', async () => {
    const text = `${row(1)}\nnot json\n${row(2)}\n{"broken":\n`;
    await put(text);
    const spy = spyIo();
    expect(await readJobRows(dir, spy.io)).toEqual(parseJobRows(text));
    expect((await readJobRows(dir)).map(r => r.tokens_total)).toEqual([1, 2]);
    expect(spy.closed()).toBe(true);
  });

  it('returns [] for a missing source and an empty file', async () => {
    expect(await readJobRows(dir)).toEqual([]);
    await put('');
    expect(await readJobRows(dir)).toEqual([]);
  });

  it('drops the crossing partial row of a >4MiB log and reads at most the cap', async () => {
    const pad = 1000; const one = row(0, pad).length + 1;
    const n = Math.ceil((CAP * 1.5) / one);
    const lines = Array.from({ length: n }, (_, i) => row(i, pad));
    const text = `${lines.join('\n')}\n`;
    await put(text);
    const spy = spyIo(64 * 1024); // forces short reads
    const rows = await readJobRows(dir, spy.io);
    const start = Buffer.byteLength(text) - CAP;
    // Expected: rows wholly inside the suffix, excluding the partial row that straddles the cut.
    let off = 0; const expected: string[] = [];
    for (const l of lines) { if (off > start) expected.push(l); off += Buffer.byteLength(l) + 1; }
    expect(rows).toEqual(parseJobRows(expected.join('\n')));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.tokens_total).toBe(n - 1);
    expect(rows[0]?.tokens_total).not.toBe(0);
    expect(Math.max(...spy.reads)).toBeLessThanOrEqual(CAP);
    expect(spy.reads[0]).toBe(CAP);
    expect(spy.closed()).toBe(true);
  });

  it('retains the first row when the suffix is newline-aligned', async () => {
    // The byte just before the retained suffix is a newline, so the row after it is complete.
    const first = row(7);
    const fixed = `${first}\n`.length + 1; // + trailing newline of the second row
    const second = row(8, CAP - 1 - fixed - row(8).length);
    const rest = `${first}\n${second}\n`;
    expect(rest.length).toBe(CAP - 1);
    await put(`${'{"a":1}\n'.repeat(3)}junk-partial\n${rest}`);
    const rows = await readJobRows(dir);
    expect(rows.map(r => r.tokens_total)).toEqual([7, 8]);
  });

  it('keeps multibyte characters near the cut intact', async () => {
    const emoji = '😀é漢';
    const mk = (i: number): string => JSON.stringify({ event: 'finish', lane: 'claude', tokens_total: i, note: emoji.repeat(50) });
    const lines = Array.from({ length: Math.ceil(CAP / 400) + 50 }, (_, i) => mk(i));
    await put(`${lines.join('\n')}\n`);
    const rows = await readJobRows(dir);
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) expect((r as { note?: string }).note).toBe(emoji.repeat(50));
    expect(rows.at(-1)?.tokens_total).toBe(lines.length - 1);
  });

  it('handles malformed final content in a large log', async () => {
    const lines = Array.from({ length: Math.ceil(CAP / 200) + 100 }, (_, i) => row(i, 100));
    await put(`${lines.join('\n')}\n{"event":"fin`);
    const rows = await readJobRows(dir);
    expect(rows.at(-1)?.tokens_total).toBe(lines.length - 1);
  });

  it('returns [] when a >cap log has no newline at all', async () => {
    await put('z'.repeat(CAP + 10));
    expect(await readJobRows(dir)).toEqual([]);
  });
});
