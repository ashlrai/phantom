import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-digest-check-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:36:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function source(id: string, date: string | null, url = true): string {
  return `## ${id} — Fake research\n${date === null ? '' : `- Checked: ${date}.\n`}${url ? '- Source: [Fake](https://example.test/fake)\n' : ''}`;
}
function file(contents: string): string {
  const path = join(dir, 'digest.md');
  writeFileSync(path, contents);
  return path;
}
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('harness digest freshness check', () => {
  it('returns zero for complete fresh sources including the freshness boundary', async () => {
    const args = ['--file', file(source('S1', '2026-10-31') + source('S2', '2026-10-24')), '--json'];
    const normal = await run(args);
    const checked = await run([...args, '--check']);
    expect(checked).toEqual({ code: 0, out: normal.out, err: '' });
    expect(JSON.parse(checked.out).sources.map((item: { stale: boolean }) => item.stale)).toEqual([false, false]);
  });

  it.each([
    ['one stale source', source('S1', '2026-10-31') + source('S2', '2026-10-23')],
    ['all stale sources', source('S1', '2026-10-01')],
    ['undated source', source('S1', null)],
    ['invalid date', source('S1', '2026-02-30')],
    ['future date', source('S1', '2026-11-01')],
    ['missing URL', source('S1', '2026-10-31', false)],
    ['duplicate ID', source('S1', '2026-10-31') + source('S1', '2026-10-31')],
    ['malformed ID alongside a fresh source', source('S1', '2026-10-31') + source('Sx', '2026-10-31')],
    ['empty digest', ''],
  ])('returns one for %s without changing the digest', async (_name, contents) => {
    const args = ['--file', file(contents), '--json'];
    const normal = await run(args);
    const checked = await run([...args, '--check']);
    expect(normal.code).toBe(0);
    expect(checked).toEqual({ code: 1, out: normal.out, err: '' });
    expect(JSON.parse(checked.out)).toHaveProperty('sources');
  });

  it('honors a custom stale threshold and rejects malformed arguments', async () => {
    const args = ['--file', file(source('S1', '2026-10-23')), '--json', '--check'];
    expect((await run(args)).code).toBe(1);
    expect((await run([...args, '--stale-days', '8'])).code).toBe(0);
    for (const invalid of [[], ['--check'], ['--file', 'x', '--check'], [...args, '--check'], [...args, '--stale-days', '-1']]) {
      const result = await run(invalid);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
    }
    const missing = await run(['--file', join(dir, 'missing.md'), '--json', '--check']);
    expect(missing.code).toBe(1);
    expect(missing.out).toBe('');
  });

  it('explains the exit contract in command help', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--check');
    expect(help.out).toContain('exit 0');
    expect(help.out).toContain('exit 1');
    expect(help.out).toContain('exit 2');
  });

  it('propagates status and JSON through the actual CLI process', () => {
    const path = file(source('S1', '2000-01-01'));
    const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'reflect', 'harness-digest', ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NO_COLOR: '1' },
    });
    const normal = invoke(['--file', path, '--json']);
    const checked = invoke(['--file', path, '--json', '--check']);
    const invalid = invoke(['--file', path, '--check']);
    expect(normal.status).toBe(0);
    expect(checked.status).toBe(1);
    expect(JSON.parse(checked.stdout)).toEqual(JSON.parse(normal.stdout));
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe('');
  }, 30_000);
});
