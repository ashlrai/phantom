import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-takeaway-cli-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:36:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const fresh = '## S1 — Fresh action\n- Checked: 2026-10-31.\n- Source: [Fake](https://example.test/1)\n- Takeaway: Act now.\n';
const stale = '## S2 — Stale action\n- Checked: 2026-10-23.\n- Source: [Fake](https://example.test/2)\n- Takeaway: Review again.\n';
const citation = '## S3 — Citation only\n- Checked: 2026-10-31.\n- Source: [Fake](https://example.test/3)\n- Takeaway:   \n';
const malformed = '## Sx — Malformed\n- Checked: 2026-10-31.\n- Source: [Fake](https://example.test/x)\n- Takeaway: Ignore malformed record.\n';

function file(markdown: string): string {
  const path = join(dir, 'digest.md');
  writeFileSync(path, markdown);
  return path;
}
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('harness digest takeaway CLI selection', () => {
  it('selects actionable records while preserving version and all selected issues', async () => {
    const args = ['--file', file(fresh + stale + citation + malformed), '--json'];
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const full = JSON.parse((await run(args)).out);
    const filtered = await run([...args, '--with-takeaways']);
    expect(filtered.code).toBe(0);
    expect(filtered.err).toBe('');
    expect(JSON.parse(filtered.out)).toEqual({ v: 1, sources: [full.sources[0], full.sources[1]], issues: [{ id: 'Sx', code: 'malformed_id' }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('intersects source, takeaway and refresh filters without discarding selected issues', async () => {
    const args = ['--file', file(fresh + stale + citation + malformed), '--json'];
    const full = JSON.parse((await run(args)).out);
    for (const flags of [['--needs-refresh', '--with-takeaways'], ['--with-takeaways', '--needs-refresh']]) {
      const result = await run([...args, ...flags, '--check']);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [full.sources[1]], issues: full.issues });
    }
    const selected = await run([...args, '--source', 'S2', '--needs-refresh', '--with-takeaways', '--check']);
    expect(selected.code).toBe(1);
    expect(JSON.parse(selected.out)).toEqual({ v: 1, sources: [full.sources[1]], issues: [] });
    const orphan = await run([...args, '--source', 'Sx', '--with-takeaways']);
    expect(orphan.code).toBe(2); // Source IDs must be S followed by digits.
  });

  it('checks the takeaway selection before refresh projection, including empty selections', async () => {
    const args = ['--file', file(fresh + stale + citation), '--json', '--with-takeaways', '--check'];
    const freshOnly = await run([...args, '--source', 'S1', '--needs-refresh']);
    expect(freshOnly.code).toBe(0);
    expect(JSON.parse(freshOnly.out)).toEqual({ v: 1, sources: [], issues: [] });
    for (const id of ['S3', 'S999']) {
      const empty = await run([...args, '--source', id]);
      expect(empty.code).toBe(1);
      expect(JSON.parse(empty.out)).toEqual({ v: 1, sources: [], issues: [] });
    }
    expect((await run(args)).code).toBe(1);
    const citationOnly = await run(['--file', file(citation), '--json', '--with-takeaways', '--check']);
    expect(citationOnly.code).toBe(1);
    expect(JSON.parse(citationOnly.out)).toEqual({ v: 1, sources: [], issues: [] });
    expect((await run(['--file', file(''), '--json', '--with-takeaways', '--check'])).code).toBe(1);
    const excludedStaleCitation = stale.replace('## S2 — Stale action', '## S2 — Stale citation').replace('- Takeaway: Review again.\n', '');
    const healthy = await run(['--file', file(fresh + excludedStaleCitation), '--json', '--with-takeaways', '--check']);
    expect(healthy.code).toBe(0);
    expect(JSON.parse(healthy.out).sources.map((source: { id: string }) => source.id)).toEqual(['S1']);
    const issues = await run(['--file', file(fresh + malformed), '--json', '--with-takeaways', '--check']);
    expect(issues.code).toBe(1);
    expect(JSON.parse(issues.out).issues).toEqual([{ id: 'Sx', code: 'malformed_id' }]);
  });

  it('prints the exact help contract', async () => {
    const result = await run(['--help']);
    expect(result).toEqual({ code: 0, err: '', out: `Usage: phm reflect harness-digest --file <markdown> --json [--source <id>] [--stale-days <n>] [--needs-refresh] [--with-takeaways] [--check]
Read a local digest (maximum 1 MiB) and emit dated HTTPS citations as JSON.
Dates are UTC calendar days; older than N days is stale (default 7, boundary is fresh).
Missing, invalid, or future dates have null checkedAt and stale, with an issue.
Malformed IDs are issues; duplicate IDs remain in sources with an issue.
Issue codes: malformed_id, duplicate_id, missing_checked, invalid_checked,
future_checked, missing_urls. Only links on Source lines are included.
With --source, select all records and issues matching an exact ID (S followed by digits).
With --needs-refresh, include only stale or undated selected sources and sources whose
IDs are referenced by selected issues; v and selected issues are preserved.
With --with-takeaways, select only sources with at least one nonblank takeaway;
this composes with --needs-refresh and preserves v and selected issues.
With --check, exit 0 for a non-empty selection with all sources fresh and no issues;
exit 1 for an empty selection, stale or undated sources, issues, or read failure.
The check evaluates the selection before --needs-refresh, after --source and
--with-takeaways. Issues remain scoped by --source and are not filtered by takeaways.
Invalid arguments exit 2. Without --check, a successfully read digest exits 0.
Options: --file <markdown>  Input file; --json  Required JSON output;
         --source <id>  Exact source ID; --stale-days <n>  Non-negative integer;
         --needs-refresh  Filter sources;
         --with-takeaways  Filter sources to those with takeaways;
         --check  Check freshness;
         --help, -h  Show help.\n` });
  });

  it('exposes the selection through the executable CLI', () => {
    const path = file('## S1 — Citation only\n- Checked: 2000-01-01.\n- Source: [Fake](https://example.test/1)\n');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'reflect', 'harness-digest', '--file', path, '--json', '--with-takeaways', '--check'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NO_COLOR: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ v: 1, sources: [], issues: [] });
  }, 30_000);
});
