import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflectHarnessDigest } from '../src/cli/reflect-harness-digest.js';
import { readHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

const now = new Date('2026-10-31T12:00:00Z');
const contents = `## S1 — Fresh example
- Checked: 2026-10-31.
- Source: [Fresh](https://example.test/fresh)
## S2 — Stale example
- Checked: 2026-10-23.
- Source: [A](https://example.test/a) [B](https://example.test/b) [A again](https://example.test/a)
- Takeaway: Revisit caching
## S3 — Undated example
- Source: [C](https://example.test/c)
## S4 — Duplicate first
- Checked: 2026-10-31.
- Source: [D](https://example.test/d)
## S4 — Duplicate second
- Checked: 2026-10-23.
- Source: [D](https://example.test/d) [E](https://example.test/e)
## S5 — Missing citation
- Checked: 2026-10-31.
- Source: [Insecure](http://example.test/no) [Bad](https://)
## S6 — Invalid date
- Checked: yesterday.
- Source: [F](https://example.test/f)
## S7 — Future date
- Checked: 2026-11-01.
- Source: [G](https://example.test/g)
## Sx — Malformed record
- Source: [Ignored](https://example.test/ignored)
`;
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'digest-plan-'));
  path = join(dir, 'digest.md');
  writeFileSync(path, contents);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): { code: number; out: string; err: string } {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: cmdReflectHarnessDigest(args, now), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}
const args = (): string[] => ['--file', path, '--json'];
const metadata = 'invalid_or_duplicate_metadata';

describe('harness digest refresh plan', () => {
  it('adds deterministic, deduplicated requests from the real reader without network access', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const original = run(args());
    const result = run([...args(), '--refresh-plan']);
    const output = JSON.parse(result.out);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(JSON.parse(original.out)).toEqual(readHarnessDigest(path, now));
    const { refreshPlan, ...digest } = output;
    expect(digest).toEqual(JSON.parse(original.out));
    expect(refreshPlan).toEqual([
      { sourceId: 'S2', url: 'https://example.test/a', reasons: ['stale'] },
      { sourceId: 'S2', url: 'https://example.test/b', reasons: ['stale'] },
      { sourceId: 'S3', url: 'https://example.test/c', reasons: ['undated'] },
      { sourceId: 'S4', url: 'https://example.test/d', reasons: ['stale', metadata] },
      { sourceId: 'S4', url: 'https://example.test/e', reasons: ['stale', metadata] },
      { sourceId: 'S5', url: null, reasons: [metadata] },
      { sourceId: 'S6', url: 'https://example.test/f', reasons: ['undated', metadata] },
      { sourceId: 'S7', url: 'https://example.test/g', reasons: ['undated', metadata] },
      { sourceId: 'Sx', url: null, reasons: [metadata] },
    ]);
    expect(run([...args(), '--refresh-plan']).out).toBe(result.out);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('respects source, query, takeaways, and refresh filtering without inventing citations', () => {
    const selected = JSON.parse(run([...args(), '--source', 'S1', '--source', 'S2', '--query', 'CACHING', '--with-takeaways', '--needs-refresh', '--refresh-plan']).out);
    expect(selected.requestedSourceIds).toEqual(['S1', 'S2']);
    expect(selected.sources.map((source: { id: string }) => source.id)).toEqual(['S2']);
    expect(selected.issues).toEqual([]);
    expect(selected.refreshPlan).toEqual([
      { sourceId: 'S2', url: 'https://example.test/a', reasons: ['stale'] },
      { sourceId: 'S2', url: 'https://example.test/b', reasons: ['stale'] },
    ]);
    const duplicate = JSON.parse(run([...args(), '--query', 'duplicate first', '--refresh-plan']).out);
    expect(duplicate.sources).toHaveLength(1);
    expect(duplicate.issues).toEqual([{ id: 'S4', code: 'duplicate_id' }]);
    expect(duplicate.refreshPlan).toEqual([{ sourceId: 'S4', url: 'https://example.test/d', reasons: [metadata] }]);
    const filtered = JSON.parse(run([...args(), '--source', 'S5', '--with-takeaways', '--refresh-plan']).out);
    expect(filtered.sources).toEqual([]);
    expect(filtered.issues).toEqual([{ id: 'S5', code: 'missing_urls' }]);
    expect(filtered.refreshPlan).toEqual([{ sourceId: 'S5', url: null, reasons: [metadata] }]);
  });

  it('keeps freshness and missing-source check semantics independent of plan generation', () => {
    const fresh = run([...args(), '--source', 'S1', '--needs-refresh', '--refresh-plan', '--check']);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.out)).toEqual({ v: 1, sources: [], issues: [], refreshPlan: [] });
    expect(run([...args(), '--source', 'S2', '--refresh-plan', '--check']).code).toBe(1);
    expect(run([...args(), '--source', 'S5', '--refresh-plan', '--check']).code).toBe(1);
    expect(run([...args(), '--source', 'S1', '--source', 'S999', '--refresh-plan', '--check']).code).toBe(1);
    expect(run([...args(), '--query', 'not found', '--refresh-plan', '--check']).code).toBe(1);
    const boundary = run([...args(), '--source', 'S2', '--stale-days', '8', '--refresh-plan', '--check']);
    expect(boundary.code).toBe(0);
    expect(JSON.parse(boundary.out).refreshPlan).toEqual([]);
  });

  it('requires JSON, rejects repetition, and documents the output', () => {
    for (const options of [['--text', '--refresh-plan'], ['--refresh-plan'], ['--json', '--refresh-plan', '--refresh-plan']]) {
      const result = run(['--file', path, ...options]);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
    }
    const help = run(['--help']);
    expect(help.out).toContain('--refresh-plan (requires --json)');
    expect(help.out).toContain('null means no citation is available');
  });
});
