import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflectHarnessDigest } from '../src/cli/reflect-harness-digest.js';

let dir: string;
const now = new Date('2026-10-31T00:36:00Z');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'digest-source-set-')); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function source(id: string, title: string, date: string, takeaway = true, url = true): string {
  return `## ${id} — ${title}\n- Checked: ${date}.\n${url ? '- Source: [Fake](https://example.test/source)\n' : ''}${takeaway ? '- Takeaway: Fictional evidence.\n' : ''}`;
}

function file(contents: string): string {
  const path = join(dir, 'digest.md');
  writeFileSync(path, contents);
  return path;
}

function run(args: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: cmdReflectHarnessDigest(args, now), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('harness digest source sets', () => {
  it('selects in digest order, retains duplicate records and all matching issues', () => {
    const path = file(source('S2', 'First', '2026-10-31', true, false) +
      source('S9', 'Excluded', '2026-10-31', true, false) +
      source('S1', 'Other selected', '2026-10-31') +
      source('S2', 'Second', '2026-10-31', false, false) + '## S3\n');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const args = ['--file', path, '--json'];
    const full = JSON.parse(run(args).out);
    const result = run([...args, '--source', 'S1', '--source', 'S2', '--source', 'S1']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toEqual({
      v: 1, sources: [full.sources[0], full.sources[2], full.sources[3]],
      issues: [
        { id: 'S2', code: 'missing_urls' }, { id: 'S2', code: 'duplicate_id' },
        { id: 'S2', code: 'missing_urls' },
      ],
      requestedSourceIds: ['S1', 'S2'],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps single-ID output compatible even when the same ID is repeated', () => {
    const args = ['--file', file(source('S1', 'Fresh', '2026-10-31')), '--json'];
    const single = run([...args, '--source', 'S1', '--check']);
    const repeated = run([...args, '--source', 'S1', '--source', 'S1', '--check']);
    expect(single.code).toBe(0);
    expect(repeated).toEqual(single);
    expect(JSON.parse(single.out)).not.toHaveProperty('requestedSourceIds');
  });

  it('fails checks for absent IDs while retaining requested IDs and selected evidence', () => {
    const args = ['--file', file(source('S1', 'Fresh', '2026-10-31') + '## S3\n'), '--json',
      '--source', 'S1', '--source', 'S999'];
    const normal = run(args);
    const checked = run([...args, '--check', '--needs-refresh', '--with-takeaways']);
    expect(normal.code).toBe(0);
    expect(checked.code).toBe(1);
    expect(JSON.parse(checked.out)).toEqual({ v: 1, sources: [], issues: [], requestedSourceIds: ['S1', 'S999'] });
    const orphan = run([...args.slice(0, -1), 'S3', '--check']);
    expect(orphan.code).toBe(1);
    expect(JSON.parse(orphan.out).issues).toEqual([{ id: 'S3', code: 'malformed_id' }]);
  });

  it('checks before refresh and keeps takeaway filtering and issue scope', () => {
    const path = file(source('S1', 'Fresh', '2026-10-31') + source('S2', 'Stale', '2026-10-23') +
      source('S3', 'No takeaway', '2026-10-31', false, false));
    const args = ['--file', path, '--json', '--source', 'S3', '--source', 'S1', '--source', 'S2'];
    const full = JSON.parse(run(args).out);
    for (const flags of [['--needs-refresh', '--with-takeaways'], ['--with-takeaways', '--needs-refresh']]) {
      const result = run([...args, ...flags, '--check']);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out)).toEqual({
        v: 1, sources: [full.sources[1]], issues: [{ id: 'S3', code: 'missing_urls' }],
        requestedSourceIds: ['S3', 'S1', 'S2'],
      });
    }
    const presentWithoutTakeaway = run(['--file', file(source('S1', 'Fresh', '2026-10-31') +
      source('S2', 'Citation only', '2026-10-31', false)), '--json', '--source', 'S1', '--source', 'S2',
    '--with-takeaways', '--needs-refresh', '--check']);
    expect(presentWithoutTakeaway.code).toBe(0);
    expect(JSON.parse(presentWithoutTakeaway.out).sources).toEqual([]);
  });

  it('rejects malformed repeated arguments and explains missing IDs in help', () => {
    const args = ['--file', file(source('S1', 'Fresh', '2026-10-31')), '--json', '--source', 'S1'];
    for (const extra of [['--source'], ['--source', '--check'], ['--source', 'Sx'], ['--source', 'S2x']]) {
      const result = run([...args, ...extra]);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toContain('invalid harness-digest arguments');
    }
    const help = run(['--help']);
    expect(help.out).toContain('Repeat --source');
    expect(help.out).toContain('an ID absent from the digest');
  });
});
