import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshWorklist, runCli } from '../examples/harness-refresh/worklist.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fake-harness-refresh-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

function digest(text: string): string {
  const file = join(root, 'fake-digest.md');
  writeFileSync(file, text);
  return file;
}

function runInProcess(args: string[]) {
  let stdout = '', stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  try { return { status: runCli(args), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}

describe('offline harness refresh example', () => {
  it('queues stale, undated and issue-linked IDs, merging duplicate evidence without fetching or executing it', () => {
    const marker = join(root, 'executed');
    const file = digest(`# Fake research
## S1 — Fresh boundary
- Checked: 2026-10-24.
- Source: [fresh](https://example.test/fresh)
## S2 — Old
- Checked: 2026-10-23.
- Source: [old](https://example.test/old) [old again](https://example.test/old)
- Evidence: $(touch ${marker})
## S3 — Missing date
- Source: [undated](https://example.test/undated)
## S4 — Future date
- Checked: 2026-11-01.
- Source: [future](https://example.test/future)
## S5 — Duplicate
- Checked: 2026-10-31.
- Source: [first](https://example.test/first)
## S5 — Duplicate again
- Checked: 2026-10-31.
- Source: [second](https://example.test/second) [first](https://example.test/first)
## S6 — Bad date and no links
- Checked: 2026-02-30.
## Sx — Malformed
`);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const expected = {
      v: 1, asOf: '2026-10-31', staleDays: 7,
      worklist: [
        { id: 'S2', urls: ['https://example.test/old'], reasons: ['stale'] },
        { id: 'S3', urls: ['https://example.test/undated'], reasons: ['undated', 'issue:missing_checked'] },
        { id: 'S4', urls: ['https://example.test/future'], reasons: ['undated', 'issue:future_checked'] },
        { id: 'S5', urls: ['https://example.test/first', 'https://example.test/second'], reasons: ['issue:duplicate_id'] },
        { id: 'S6', urls: [], reasons: ['undated', 'issue:invalid_checked', 'issue:missing_urls'] },
      ],
      unmatchedIssues: [{ id: 'Sx', code: 'malformed_id' }],
    };
    expect(refreshWorklist(file, new Date('2026-10-31T23:59:59Z'))).toEqual(expected);
    expect(fetch).not.toHaveBeenCalled();
    const cli = runInProcess([file, '2026-10-31']);
    expect(cli.status).toBe(0);
    expect(cli.stderr).toBe('');
    expect(JSON.parse(cli.stdout)).toEqual(expected);
    expect(existsSync(marker)).toBe(false);
  });

  it('uses the supplied clock and handles an empty digest', () => {
    const file = digest('## S1 — Example\n- Checked: 2026-10-24.\n- Source: [x](https://example.test/x)\n');
    expect(refreshWorklist(file, new Date('2026-10-31T00:00:00Z')).worklist).toEqual([]);
    expect(refreshWorklist(file, new Date('2026-11-01T00:00:00Z')).worklist).toEqual([
      { id: 'S1', urls: ['https://example.test/x'], reasons: ['stale'] },
    ]);
    expect(refreshWorklist(digest(''), new Date('2026-10-31T00:00:00Z'))).toEqual({
      v: 1, asOf: '2026-10-31', staleDays: 7, worklist: [], unmatchedIssues: [],
    });
  });

  it('fails without JSON on invalid dates, arguments and unsafe or missing inputs', () => {
    const file = digest('');
    const link = join(root, 'fake-link.md');
    symlinkSync(file, link);
    for (const args of [[], [file], [file, '2026-02-30'], [file, 'not-a-date'], [file, '2026-10-31', 'extra']]) {
      const result = runInProcess(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    }
    for (const target of [link, root, join(root, 'missing.md')]) {
      const result = runInProcess([target, '2026-10-31']);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(target);
    }
    expect(() => refreshWorklist(file, new Date('invalid'))).toThrow('Invalid clock');
  });
});
