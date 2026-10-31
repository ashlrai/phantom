import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflectHarnessDigest } from '../src/cli/reflect-harness-digest.js';

const now = new Date('2026-10-31T00:36:00Z');
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-task-search-'));
  path = join(dir, 'digest.md');
  writeFileSync(path, [
    '## S1 — Trace capture for task diagnosis',
    '- Checked: 2026-10-31.', '- Source: [Fake](https://example.test/1)',
    '- Takeaway: Record the failing step.',
    '## S2 — Evaluation loop',
    '- Checked: 2026-10-23.', '- Source: [Fake](https://example.test/2)',
    '- Takeaway: Capture TRACE before retry.',
    '  Café 🐈 uses literal [a.*] markers.',
    '## S3 — Other work',
    '- Checked: 2026-10-31.', '- Evidence: trace is not an explicit takeaway',
    '## S4 — Trace without note',
    '- Checked: 2026-10-23.', '- Source: [Fake](https://example.test/4)',
    '## Sx — Malformed',
  ].join('\n'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function run(extra: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try {
    const code = cmdReflectHarnessDigest(['--file', path, '--json', ...extra], now);
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('harness digest task search', () => {
  it('matches trimmed case-insensitive title and explicit takeaway substrings, retaining issues and metadata', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const full = JSON.parse(run([]).out);
    const result = run(['--query', '  tRaCe  ']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [full.sources[0], full.sources[1], full.sources[3]], issues: full.issues });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('matches Unicode and regex punctuation literally', () => {
    const full = JSON.parse(run([]).out);
    for (const query of ['CAFÉ 🐈', '[a.*]']) {
      expect(JSON.parse(run(['--query', query]).out)).toEqual({ v: 1, sources: [full.sources[1]], issues: full.issues });
    }
    expect(JSON.parse(run(['--query', 'a.+']).out)).toEqual({ v: 1, sources: [], issues: full.issues });
  });

  it('intersects source, refresh and takeaway filters while preserving selected issues', () => {
    const full = JSON.parse(run([]).out);
    const args = ['--source', 'S2', '--needs-refresh', '--with-takeaways', '--query', 'trace', '--check'];
    const result = run(args);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [full.sources[1]], issues: [] });
    const issue = run(['--source', 'S3', '--needs-refresh', '--with-takeaways', '--query', 'trace', '--check']);
    expect(issue.code).toBe(1);
    expect(JSON.parse(issue.out)).toEqual({ v: 1, sources: [], issues: [{ id: 'S3', code: 'missing_urls' }] });
  });

  it('checks selected sources before display filters, including empty results', () => {
    const fresh = run(['--source', 'S1', '--query', 'absent', '--needs-refresh', '--with-takeaways', '--check']);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.out)).toEqual({ v: 1, sources: [], issues: [] });
    const stale = run(['--source', 'S2', '--query', 'absent', '--check']);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out)).toEqual({ v: 1, sources: [], issues: [] });
    const full = run(['--query', 'absent', '--check']);
    expect(full.code).toBe(1);
    expect(JSON.parse(full.out)).toEqual({ v: 1, sources: [], issues: [{ id: 'S3', code: 'missing_urls' }, { id: 'Sx', code: 'malformed_id' }] });
    expect(run(['--source', 'S999', '--query', 'trace', '--check']).code).toBe(1);
  });

  it('rejects empty, oversized, missing and repeated queries; accepts 256 Unicode characters', () => {
    for (const args of [['--query'], ['--query', ''], ['--query', '  \t'], ['--query', 'x'.repeat(257)],
      ['--query', '🐈'.repeat(257)], ['--query', 'x', '--query', 'y']]) {
      const result = run(args);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toContain('invalid harness-digest arguments');
    }
    expect(run(['--query', ` ${'🐈'.repeat(256)} `]).code).toBe(0);
    const help = run(['--help']);
    expect(help.out).toContain('--query <text>');
    expect(help.out).toContain('does not affect --check');
  });
});
