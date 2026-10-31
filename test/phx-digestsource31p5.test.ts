import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-digest-source-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:36:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function source(id: string, title: string, date: string | null, url = true): string {
  return `## ${id} — ${title}\n${date === null ? '' : `- Checked: ${date}.\n`}${url ? '- Source: [Fake](https://example.test/fake)\n' : ''}`;
}
function fixture(): string {
  const path = join(dir, 'digest.md');
  writeFileSync(path, source('S1', 'Fresh', '2026-10-31') +
    source('S10', 'Stale', '2026-10-23') +
    source('S2', 'First duplicate', null) + source('S2', 'Second duplicate', '2026-10-31', false) +
    '## S3\n' + source('Sx', 'Malformed', '2026-10-31'));
  return path;
}
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('harness digest exact source selection', () => {
  it('selects exact IDs and scopes issues while preserving duplicate records and issue order', async () => {
    const args = ['--file', fixture(), '--json'];
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const full = JSON.parse((await run(args)).out);
    const fresh = await run([...args, '--source', 'S1', '--check']);
    expect(fresh.code).toBe(0);
    expect(fresh.err).toBe('');
    expect(JSON.parse(fresh.out)).toEqual({ v: 1, sources: [full.sources[0]], issues: [] });
    const duplicates = await run([...args, '--source', 'S2', '--check']);
    expect(duplicates.code).toBe(1);
    expect(JSON.parse(duplicates.out)).toEqual({ v: 1, sources: full.sources.slice(2, 4), issues: [
      { id: 'S2', code: 'missing_checked' }, { id: 'S2', code: 'duplicate_id' },
      { id: 'S2', code: 'missing_urls' },
    ] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies refresh projection after selection but checks the unprojected selection', async () => {
    const args = ['--file', fixture(), '--json', '--needs-refresh', '--check'];
    const fresh = await run([...args, '--source', 'S1']);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.out)).toEqual({ v: 1, sources: [], issues: [] });
    const stale = await run([...args, '--source', 'S10']);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out).sources.map((s: { id: string }) => s.id)).toEqual(['S10']);
    const custom = await run([...args, '--source', 'S10', '--stale-days', '8']);
    expect(custom.code).toBe(0);
    expect(JSON.parse(custom.out)).toEqual({ v: 1, sources: [], issues: [] });
    const duplicates = await run([...args, '--source', 'S2']);
    expect(duplicates.code).toBe(1);
    expect(JSON.parse(duplicates.out).sources.map((s: { title: string }) => s.title)).toEqual(['First duplicate', 'Second duplicate']);
  });

  it('returns empty unknown selections and retains matching orphan issues', async () => {
    const args = ['--file', fixture(), '--json'];
    const unknown = await run([...args, '--source', 'S999']);
    expect(unknown.code).toBe(0);
    expect(JSON.parse(unknown.out)).toEqual({ v: 1, sources: [], issues: [] });
    expect((await run([...args, '--source', 'S999', '--check'])).code).toBe(1);
    const orphan = await run([...args, '--source', 'S3', '--needs-refresh', '--check']);
    expect(orphan.code).toBe(1);
    expect(JSON.parse(orphan.out)).toEqual({ v: 1, sources: [], issues: [{ id: 'S3', code: 'malformed_id' }] });
    const emptyPath = join(dir, 'empty.md');
    writeFileSync(emptyPath, '');
    expect((await run(['--file', emptyPath, '--json', '--source', 'S1', '--check'])).code).toBe(1);
  });

  it('keeps full-digest checks and issues when no source is selected', async () => {
    const args = ['--file', fixture(), '--json'];
    const full = JSON.parse((await run(args)).out);
    expect((await run([...args, '--check'])).code).toBe(1);
    const filtered = await run([...args, '--needs-refresh', '--check']);
    expect(filtered.code).toBe(1);
    expect(JSON.parse(filtered.out).issues).toEqual(full.issues);
    const freshPath = join(dir, 'fresh.md');
    writeFileSync(freshPath, source('S1', 'Fresh', '2026-10-31'));
    const checked = await run(['--file', freshPath, '--json', '--needs-refresh', '--check']);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.out)).toEqual({ v: 1, sources: [], issues: [] });
  });

  it('rejects malformed or repeated source flags and documents the contract', async () => {
    const args = ['--file', fixture(), '--json'];
    for (const extra of [['--source'], ['--source', '--check'], ['--source', ''],
      ...['s1', 'S', 'Sx', 'S1x', 'S-1', ' S1', 'S1 ', '1'].map(id => ['--source', id]),
      ['--source', 'S1', '--source', 'S2']]) {
      const result = await run([...args, ...extra]);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toContain('invalid harness-digest arguments');
    }
    const help = await run(['--help']);
    expect(help.out).toContain('--source <id>');
    expect(help.out).toContain('selection before --needs-refresh');
  });
});
