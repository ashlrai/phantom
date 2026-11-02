import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHarnessWorklist } from '../examples/agents/harness-worklist.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-worklist-')); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

function run(args: string[], now = new Date('2026-10-31T12:00:00Z')) {
  let stdout = '';
  let stderr = '';
  const status = runHarnessWorklist(args, {
    now: () => now,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { status, stdout, stderr };
}

function writeDigest(text: string): string {
  const file = join(dir, 'digest.md');
  writeFileSync(file, text);
  return file;
}

describe('harness worklist', () => {
  it('returns individual stale, undated and issue-bearing sources with citations and all issues', () => {
    const marker = join(dir, 'executed');
    const file = writeDigest(`## S1 — Fresh boundary
- Checked: 2026-10-24.
- Source: [fresh](https://example.test/fresh)
## S2 — Stale
- Checked: 2026-10-23.
- Source: [old](https://example.test/old)
- Evidence: $(touch ${marker})
## S3 — Undated
- Source: [undated](https://example.test/undated)
## S4 — Future
- Checked: 2026-11-01.
- Source: [future](https://example.test/future)
## S5 — First duplicate
- Checked: 2026-10-31.
- Source: [first](https://example.test/first)
## S5 — Second duplicate
- Checked: 2026-02-30.
## Sx — Malformed
`);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = run(['--file', file]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1, asOf: '2026-10-31', staleDays: 7,
      worklist: [
        { id: 'S2', title: 'Stale', checkedAt: '2026-10-23', stale: true, urls: ['https://example.test/old'], issueCodes: [] },
        { id: 'S3', title: 'Undated', checkedAt: null, stale: null, urls: ['https://example.test/undated'], issueCodes: ['missing_checked'] },
        { id: 'S4', title: 'Future', checkedAt: null, stale: null, urls: ['https://example.test/future'], issueCodes: ['future_checked'] },
        { id: 'S5', title: 'First duplicate', checkedAt: '2026-10-31', stale: false, urls: ['https://example.test/first'], issueCodes: ['duplicate_id', 'invalid_checked', 'missing_urls'] },
        { id: 'S5', title: 'Second duplicate', checkedAt: null, stale: null, urls: [], issueCodes: ['duplicate_id', 'invalid_checked', 'missing_urls'] },
      ],
      unmatchedIssues: [{ id: 'Sx', code: 'malformed_id' }],
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it('supports an empty digest and an injected clock', () => {
    const file = writeDigest('## S1 — Example\n- Checked: 2026-10-24.\n- Source: [x](https://example.test/x)\n');
    expect(JSON.parse(run(['--file', file]).stdout).worklist).toEqual([]);
    expect(JSON.parse(run(['--file', file], new Date('2026-11-01T00:00:00Z')).stdout).worklist[0].id).toBe('S1');
    expect(JSON.parse(run(['--file', writeDigest('')]).stdout).worklist).toEqual([]);
  });

  it('rejects invalid arguments without reading and offers help', () => {
    const read = vi.fn();
    const stdout = vi.fn();
    const stderr = vi.fn();
    for (const args of [[], ['--file'], ['--file', '--help'], ['other'], ['--file', 'a', 'extra'], ['--help', 'extra']]) {
      expect(runHarnessWorklist(args, { read, stdout, stderr })).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(run(['--help'])).toMatchObject({ status: 0, stderr: '' });
    expect(run(['--help']).stdout).toContain('--file');
  });

  it('fails closed for missing, unsafe and oversized files and invalid clocks without exposing paths', () => {
    const file = writeDigest('fixture');
    const link = join(dir, 'link.md');
    symlinkSync(file, link);
    const large = join(dir, 'large.md');
    writeFileSync(large, 'x'.repeat(1024 * 1024 + 1));
    for (const path of [join(dir, 'missing.md'), dir, link, large]) {
      const result = run(['--file', path]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(path);
    }
    expect(run(['--file', file], new Date('invalid'))).toMatchObject({ status: 1, stdout: '' });
  });

  it('runs as the documented executable', () => {
    const file = writeDigest('## S1 — Old\n- Checked: 2000-01-01.\n- Source: [x](https://example.test/x)\n');
    const result = spawnSync('npx', ['tsx', 'examples/agents/harness-worklist.ts', '--file', file], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).worklist[0]).toMatchObject({ id: 'S1', stale: true, urls: ['https://example.test/x'] });
  }, 30_000);
});
