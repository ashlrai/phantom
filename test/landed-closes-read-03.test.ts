import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readLandedCloses } from '../src/core/fleet/landed-closes-read.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'landed-closes-')); mkdirSync(join(dir, 'queue')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = () => join(dir, 'queue', 'landed-closes.jsonl');
const write = (lines: unknown[]) => writeFileSync(file(), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');

it('missing file is known with zero counts', async () => {
  expect(await readLandedCloses(dir, now)).toEqual({ v: 1, known: true, closed: 0, skipped: 0, failed: 0, rows: [] });
});

it('counts valid in-window rows newest first and skips junk', async () => {
  write([
    { at: ago(5), pr: 11, head: 'a', outcome: 'closed' },
    { at: ago(1), pr: 12, head: 'b', outcome: 'failed', reason: 'gh said no' },
    { at: ago(3), pr: 13, head: 'c', outcome: 'skipped', reason: 'not dirty' },
    { at: ago(30), pr: 14, outcome: 'closed' },
    { at: ago(2), pr: 0, outcome: 'closed' },
    { at: ago(2), pr: 1.5, outcome: 'closed' },
    { at: ago(2), pr: 15, outcome: 'merged' },
    'not json {',
    '[1,2]',
  ]);
  const r = await readLandedCloses(dir, now);
  expect(r).toMatchObject({ known: true, closed: 1, skipped: 1, failed: 1 });
  expect(r.rows?.map(x => x.pr)).toEqual([12, 13, 11]);
  expect(r.rows?.[0]).toEqual({ at: ago(1), pr: 12, outcome: 'failed', reason: 'gh said no' });
});

it('caps rows at 20 but counts all', async () => {
  write(Array.from({ length: 25 }, (_, i) => ({ at: ago(1 + i / 100), pr: i + 1, outcome: 'closed' })));
  const r = await readLandedCloses(dir, now);
  expect(r.rows).toHaveLength(20);
  expect(r.closed).toBe(25);
});

it('scrubs the home path from reasons and trims length', async () => {
  write([{ at: ago(1), pr: 7, outcome: 'failed', reason: `cannot open ${homedir()}/fake-proj/x ${'y'.repeat(300)}` }]);
  const reason = (await readLandedCloses(dir, now)).rows![0]!.reason!;
  expect(reason).not.toContain(homedir());
  expect(reason).toContain('~/fake-proj');
  expect(reason.length).toBeLessThanOrEqual(160);
});

it('reads only the tail of a large file', async () => {
  const filler = JSON.stringify({ at: ago(1), pr: 99, outcome: 'closed' });
  const lines = Array(Math.ceil(300 * 1024 / (filler.length + 1))).fill(filler);
  write([{ at: ago(1), pr: 5, outcome: 'failed' }, ...lines]);
  const r = await readLandedCloses(dir, now);
  expect(r.failed).toBe(0);
  expect(r.closed).toBeGreaterThan(0);
});

it('an unreadable path is known:false', async () => {
  mkdirSync(file());
  expect(await readLandedCloses(dir, now)).toEqual({ v: 1, known: false, closed: 0, skipped: 0, failed: 0, rows: null });
});
