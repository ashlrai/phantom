import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'digest-refresh-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:36:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function source(id: string, date: string | null, url = true): string {
  return `## ${id} — Fictional source\n${date === null ? '' : `- Checked: ${date}.\n`}${url ? '- Source: [Example](https://example.test/source)\n' : ''}`;
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

describe('harness digest refresh projection', () => {
  it('retains stale, undated and issue-bearing fresh sources in order with all issues', async () => {
    const contents = source('S1', '2026-10-31') + source('S2', '2026-10-23') +
      source('S3', null) + source('S4', '2026-10-31', false) + source('Sx', '2026-10-31');
    const args = ['--file', file(contents), '--json'];
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const normal = await run(args);
    const projected = await run([...args, '--needs-refresh']);
    expect(normal.code).toBe(0);
    expect(projected.code).toBe(0);
    expect(projected.err).toBe('');
    const full = JSON.parse(normal.out);
    const filtered = JSON.parse(projected.out);
    expect(full.sources.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(filtered).toEqual({ v: 1, sources: full.sources.slice(1), issues: full.issues });
    expect(filtered.issues).toEqual([
      { id: 'S3', code: 'missing_checked' }, { id: 'S4', code: 'missing_urls' },
      { id: 'Sx', code: 'malformed_id' },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect((await run([...args, '--needs-refresh', '--check'])).code).toBe(1);
  });

  it('checks the full digest even when a healthy source is filtered out', async () => {
    const args = ['--file', file(source('S1', '2026-10-24')), '--json'];
    const projected = await run([...args, '--needs-refresh', '--check']);
    expect(projected.code).toBe(0);
    expect(JSON.parse(projected.out)).toEqual({ v: 1, sources: [], issues: [] });
    expect(JSON.parse((await run(args)).out).sources).toHaveLength(1);
  });

  it('preserves an empty digest and its failing check', async () => {
    const args = ['--file', file(''), '--json', '--needs-refresh'];
    const result = await run(args);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [], issues: [] });
    expect((await run([...args, '--check'])).code).toBe(1);
  });

  it('honors custom thresholds and retains all sources sharing an issue ID', async () => {
    const args = ['--file', file(source('S1', '2026-10-23') + source('S2', '2026-10-31') + source('S2', '2026-10-31')), '--json', '--needs-refresh'];
    const normal = JSON.parse((await run(args)).out);
    expect(normal.sources.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2', 'S2']);
    const custom = JSON.parse((await run([...args, '--stale-days', '8'])).out);
    expect(custom.sources.map((s: { id: string }) => s.id)).toEqual(['S2', 'S2']);
    expect(custom.issues).toEqual([{ id: 'S2', code: 'duplicate_id' }]);
  });

  it('preserves orphaned issues and reports failure even when no sources remain', async () => {
    const result = await run(['--file', file(source('S1', '2026-10-31') + source('Sx', '2026-10-31')), '--json', '--needs-refresh', '--check']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [], issues: [{ id: 'Sx', code: 'malformed_id' }] });
  });

  it('rejects invalid arguments and unsafe or unreadable inputs without exposing paths', async () => {
    const path = file(source('S1', '2026-10-31'));
    for (const args of [['--file', path, '--needs-refresh'], ['--file', path, '--json', '--needs-refresh', '--needs-refresh']]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
    }
    const link = join(dir, 'link.md');
    symlinkSync(path, link);
    const large = join(dir, 'large.md');
    writeFileSync(large, 'x'.repeat(1024 * 1024 + 1));
    for (const target of [join(dir, 'missing.md'), dir, link, large]) {
      const result = await run(['--file', target, '--json', '--needs-refresh']);
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).not.toContain(target);
    }
  });

  it('documents the projection and full-digest check in help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('--needs-refresh');
    expect(result.out).toContain('check always evaluates the full digest');
  });
});
