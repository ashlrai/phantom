import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetResetHistory } from '../src/cli/fleet-reset-history.js';
import { readResetReleases } from '../src/core/fleet/usage-reset-release.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reset-history-')); dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  const rows = Array.from({ length: 25 }, (_, i) => JSON.stringify({ lane: i % 2 ? 'beta' : 'alpha', at: `time-${i}`, state: 'hold-expired', usedPct: i, readingAsOf: `reading-${i}`, heldUntil: null, reason: 'private reason' }));
  rows.splice(3, 0, '{broken');
  rows.push(JSON.stringify({ lane: 'evil\u001b[31m', at: '/private/example/path', state: 'reset-detected', readingAsOf: 'sk-test-FAKEFAKEFAKEFAKEFAKEFAKE', reason: 'private reason' }));
  await writeFile(join(dir, 'queue', 'reset-releases.jsonl'), rows.join('\n'));
  return dir;
}
async function run(args: string[], read?: typeof readResetReleases) {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetResetHistory(args, { read, output: text => out.push(text), error: text => err.push(text) });
  return { code, out, err };
}
describe('fleet reset-history', () => {
  it('reads the bounded audit in reader order, filters before limiting and makes no writes', async () => {
    const dir = await fixture(), file = join(dir, 'queue', 'reset-releases.jsonl');
    const before = await readFile(file, 'utf8');
    const expected = await readResetReleases(dir, 200);
    const all = await run(['--runs-dir', dir, '--limit', '4', '--json']);
    expect(all.code).toBe(0);
    expect(JSON.parse(all.out[0]!).records.map((r: { lane: string }) => r.lane)).toEqual(expected.slice(0, 4).map(r => r.lane));
    const filtered = await run(['--runs-dir', dir, '--lane', 'alpha', '--limit', '12', '--json']);
    expect(JSON.parse(filtered.out[0]!).records.map((r: { at: string }) => r.at)).toEqual(expected.filter(r => r.lane === 'alpha').slice(0, 12).map(r => r.at));
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(dir)).toEqual(['queue']);
    expect(await readdir(join(dir, 'queue'))).toEqual(['reset-releases.jsonl']);
  });
  it('returns empty history successfully and rejects invalid arguments before reading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reset-empty-')); dirs.push(dir);
    const result = await run(['--runs-dir', dir, '--json']);
    expect(JSON.parse(result.out[0]!)).toEqual({ v: 1, records: [] });
    const read = vi.fn<typeof readResetReleases>();
    for (const args of [['--limit', '0'], ['--limit', '201'], ['--limit', '1.5'], ['--limit', '1', '--limit', '2'], ['--json', '--json'], ['--lane'], ['--runs-dir', 'relative'], ['--unknown']]) {
      expect((await run(args, read)).code).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
  it('sanitizes both formats and escapes terminal controls without exposing reasons or paths', async () => {
    const dir = await fixture();
    for (const args of [[], ['--json']]) {
      const result = await run(['--runs-dir', dir, '--limit', '1', ...args]);
      expect(result.code).toBe(0);
      expect(result.out[0]).not.toContain('\u001b');
      expect(result.out[0]).not.toContain('/private/example/path');
      expect(result.out[0]).not.toContain('private reason');
      expect(result.out[0]).not.toContain('sk-test-FAKEFAKEFAKEFAKEFAKEFAKE');
      if (!args.length) expect(result.out[0]).toContain('not a live lane-health verdict');
    }
  });
});
