import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';

let dir: string;
let path: string;
const digest = `## S1 — Harness Caching [v1.2]
- Checked: 2026-10-31.
- Source: [Fake](https://example.test/1)
- Takeaway: Use retry budgets. --help
## S2 — Older learning
- Checked: 2026-10-23.
- Source: [Fake](https://example.test/2)
- Takeaway: Protect CAFÉ workers with backoff.
## S3 — Citation only
- Checked: 2026-10-31.
- Source: [Fake](https://example.test/3)
## S4 — Broken source
- Takeaway: retry this later
## S5 — Duplicate match
- Checked: 2026-10-31.
- Source: [Fake](https://example.test/5)
## S5 — Other duplicate
- Checked: 2026-10-31.
- Source: [Fake](https://example.test/5)
## Sx — Malformed
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'digest-search-'));
  path = join(dir, 'digest.md');
  writeFileSync(path, digest);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:36:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

async function run(extra: string[] = []): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', '--file', path, '--json', ...extra]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('harness digest literal text search', () => {
  it('matches titles and retained takeaways without network access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const title = await run(['--query', 'hArNeSs']);
    expect(title.code).toBe(0);
    expect(title.err).toBe('');
    expect(JSON.parse(title.out).sources.map((s: { id: string }) => s.id)).toEqual(['S1']);
    const takeaway = await run(['--query', 'RETRY']);
    const parsed = JSON.parse(takeaway.out);
    expect(parsed.sources.map((s: { id: string }) => s.id)).toEqual(['S1', 'S4']);
    expect(parsed.issues).toEqual([{ id: 'S4', code: 'missing_checked' }, { id: 'S4', code: 'missing_urls' }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('handles Unicode case and treats punctuation and whitespace literally', async () => {
    for (const [query, ids] of [['café', ['S2']], ['[V1.2]', ['S1']], ['v1.2]', ['S1']], ['v1x2', []], [' retry ', ['S1']]] as const) {
      const result = await run(['--query', query]);
      expect(JSON.parse(result.out).sources.map((s: { id: string }) => s.id)).toEqual(ids);
    }
    const flagText = await run(['--query', '--help']);
    expect(flagText.code).toBe(0);
    expect(JSON.parse(flagText.out).sources.map((s: { id: string }) => s.id)).toEqual(['S1']);
  });

  it('intersects source and takeaway filters and scopes issues to matching IDs', async () => {
    const selected = await run(['--source', 'S1', '--source', 'S2', '--query', 'café', '--with-takeaways']);
    const data = JSON.parse(selected.out);
    expect(data.sources.map((s: { id: string }) => s.id)).toEqual(['S2']);
    expect(data.requestedSourceIds).toEqual(['S1', 'S2']);
    expect(data.issues).toEqual([]);
    expect(JSON.parse((await run(['--query', 'citation', '--with-takeaways'])).out)).toEqual({ v: 1, sources: [], issues: [] });
    const duplicate = JSON.parse((await run(['--query', 'duplicate match'])).out);
    expect(duplicate.sources.map((s: { title: string }) => s.title)).toEqual(['Duplicate match']);
    expect(duplicate.issues).toEqual([{ id: 'S5', code: 'duplicate_id' }]);
  });

  it('checks the query selection before refresh projection and preserves missing-ID checks', async () => {
    const fresh = await run(['--query', 'harness', '--needs-refresh', '--check']);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.out)).toEqual({ v: 1, sources: [], issues: [] });
    const stale = await run(['--query', 'café', '--needs-refresh', '--with-takeaways', '--check']);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out).sources.map((s: { id: string }) => s.id)).toEqual(['S2']);
    const issue = await run(['--query', 'broken', '--needs-refresh', '--check']);
    expect(issue.code).toBe(1);
    expect(JSON.parse(issue.out).issues).toHaveLength(2);
    const empty = await run(['--query', 'no match', '--check']);
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.out)).toEqual({ v: 1, sources: [], issues: [] });
    expect((await run(['--source', 'S999', '--source', 'S1', '--query', 'harness', '--check'])).code).toBe(1);
  });

  it('rejects missing, blank and repeated queries and explains the contract', async () => {
    for (const args of [['--query'], ['--query', ''], ['--query', ' \t '], ['--query', 'one', '--query', 'two']]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toContain('invalid harness-digest arguments');
    }
    const help = await run(['--help']);
    expect(help.out).toContain('--query <text>');
    expect(help.out).toContain('case-insensitive literal substring');
    expect(help.out).toContain('no semantic or code index or network');
  });

  it('leaves existing output bytes unchanged when the query flag is absent', async () => {
    const result = await run(['--source', 'S3', '--check']);
    expect(result).toEqual({ code: 0, err: '', out: '{"v":1,"sources":[{"id":"S3","title":"Citation only","checkedAt":"2026-10-31","urls":["https://example.test/3"],"stale":false}],"issues":[]}\n' });
  });
});
