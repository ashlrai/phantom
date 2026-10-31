import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';
import * as reads from '../src/core/util/stable-file-read.js';

const fixture = `# Harness learning

## S1 — Trace capture patterns
- Checked: 2026-10-24.
- Source: Examples from [Alpha](https://example.test/alpha) and [Beta](https://example.test/beta).
- Evidence: A fictional team logs a trace before reviewing failures.
- Source: [Alpha again](https://example.test/alpha) and [insecure](http://example.test/no).

## S2 — Evaluation loop
- Checked: 2026-10-23.
- Source: [Study](https://research.example.test/eval).
- Evidence: A fictional evaluation loop compares a baseline with new cases.
`;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-digest-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T23:59:59Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
function file(name: string, text: string): string {
  const target = join(dir, name);
  writeFileSync(target, text);
  return target;
}
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('reflect harness-digest', () => {
  it('extracts ordered unique HTTPS citations with calendar-day freshness and no network', async () => {
    const target = file('digest.md', fixture);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await run(['--file', target, '--json']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [
      { id: 'S1', title: 'Trace capture patterns', checkedAt: '2026-10-24', urls: ['https://example.test/alpha', 'https://example.test/beta'], stale: false },
      { id: 'S2', title: 'Evaluation loop', checkedAt: '2026-10-23', urls: ['https://research.example.test/eval'], stale: true },
    ], issues: [] });
    expect(fetch).not.toHaveBeenCalled();
    const custom = await run(['--json', '--stale-days', '8', '--file', target]);
    expect(JSON.parse(custom.out).sources[1].stale).toBe(false);
  });

  it('reports incomplete, invalid, future, duplicate and malformed entries without invented dates', async () => {
    const target = file('incomplete.md', `## S1 — Invalid date
- Checked: 2026-02-30.
- Source: [one](https://example.test/one)
## S2 — Future date
- Checked: 2026-11-01.
- Source: [two](https://example.test/two)
## S3 — Missing fields
Evidence only.
## S1 — Duplicate
- Checked: 2026-10-31.
- Source: [bad](https://) [valid](https://example.test/three)
## Sx — Malformed
- Checked: 2026-10-31.
## S4
- Checked: 2026-10-31.
`);
    const result = await run(['--file', target, '--json', '--stale-days', '0']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.sources.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2', 'S3', 'S1']);
    expect(parsed.sources.slice(0, 3).map((s: { checkedAt: null; stale: null }) => [s.checkedAt, s.stale])).toEqual([[null, null], [null, null], [null, null]]);
    expect(parsed.sources[3]).toMatchObject({ checkedAt: '2026-10-31', stale: false, urls: ['https://example.test/three'] });
    expect(parsed.issues).toEqual([
      { id: 'S1', code: 'invalid_checked' }, { id: 'S2', code: 'future_checked' },
      { id: 'S3', code: 'missing_checked' }, { id: 'S3', code: 'missing_urls' },
      { id: 'S1', code: 'duplicate_id' }, { id: 'Sx', code: 'malformed_id' },
      { id: 'S4', code: 'malformed_id' },
    ]);
  });

  it('returns an empty JSON document for an empty digest', async () => {
    const result = await run(['--file', file('empty.md', ''), '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [], issues: [] });
  });

  it('fails closed on missing, oversized, nonregular and symlink inputs without revealing paths', async () => {
    const large = file('large.md', 'x'.repeat(1024 * 1024 + 1));
    const link = join(dir, 'link.md');
    symlinkSync(large, link);
    for (const target of [join(dir, 'missing.md'), large, dir, link]) {
      const result = await run(['--file', target, '--json']);
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).not.toContain(target);
    }
  });

  it('shows help without reading and rejects invalid arguments before reading', async () => {
    const read = vi.spyOn(reads, 'readStableRegularFile');
    const help = await run(['--file', '/nonexistent', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--stale-days');
    for (const args of [[], ['--json'], ['--file', 'x'], ['--file', 'x', '--json', '--extra'],
      ['--file', 'x', '--json', '--file', 'y'], ['--file', 'x', '--json', '--json'],
      ...['-1', '1.5', 'NaN', '9007199254740992', ''].map(n => ['--file', 'x', '--json', '--stale-days', n])]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
    }
    expect(read).not.toHaveBeenCalled();
  });
});
