import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetTeammateLatency } from '../src/cli/fleet-teammate-latency.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');
const iso = (minsAgo: number): string => new Date(NOW - minsAgo * 60_000).toISOString();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmlat-cli-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'imessage'), { recursive: true });
  const rows = [
    { v: 1, at: iso(60), rowid: 1, senderId: 'imessage:fake', text: 'zebra can you look?' },
    { v: 1, answered: 1, at: iso(57) },
    { v: 1, at: iso(14), rowid: 2, senderId: 'imessage:fake', text: 'zebra please help?' },
  ];
  writeFileSync(join(dir, 'imessage', 'teammates.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

async function run(args: string[], runsDir?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdFleetTeammateLatency(args, { output: (t) => out.push(t), error: (t) => err.push(t), runsDir, now: () => NOW });
  return { code, out, err };
}

describe('fleet teammate-latency', () => {
  it('prints the text line', async () => {
    const r = await run([], fixture());
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['Dot texts 24h: 2, answered 1 (median 3m, p90 3m, max 3m), 1 within 5m; oldest unanswered: row 2, 14m, reply']);
  });

  it('--json has the summary shape and no text', async () => {
    const r = await run(['--json', '--window-hours', '2', '--target-minutes', '2'], fixture());
    const j = JSON.parse(r.out[0]!);
    expect(j).toMatchObject({ v: 1, windowHours: 2, targetMinutes: 2, texts: 2, answered: 1, unanswered: 1, ignorable: 0, withinTarget: 0, sourceState: 'healthy' });
    expect(r.out[0]).not.toContain('zebra');
  });

  it.each([['--window-hours', '0'], ['--window-hours', '169'], ['--window-hours', 'x'], ['--target-minutes', '0'], ['--target-minutes', '121'], ['--bogus', '1']])(
    'rejects %s %s with exit 2', async (flag, value) => {
      const r = await run([flag, value], fixture());
      expect(r.code).toBe(2);
      expect(r.out).toEqual([]);
    });

  it('missing source exits 0 with zero counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmlat-cli-'));
    dirs.push(dir);
    const r = await run(['--json'], dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ sourceState: 'missing', texts: 0 });
  });
});
