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

  // Help extensions landed in PRs #2079, #2161, #2272, #2327 and #2623.
  it('prints the exact help contract', async () => {
    const result = await run(['--help']);
    expect(result).toEqual({ code: 0, err: '', out: `Usage: phm reflect harness-digest --file <markdown> (--json | --text) [--source <id>]... [--query <text>] [--stale-days <n>] [--needs-refresh] [--with-takeaways] [--refresh-plan] [--check]
Read a local digest (maximum 1 MiB) and emit dated HTTPS citations as JSON.
Dates are UTC calendar days; older than N days is stale (default 7, boundary is fresh).
Missing, invalid, or future dates have null checkedAt and stale, with an issue.
Malformed IDs are issues; duplicate IDs remain in sources with an issue.
Issue codes: malformed_id, duplicate_id, missing_checked, invalid_checked,
future_checked, missing_urls. Only links on Source lines are included.
Repeat --source to select records and issues matching any exact ID (S followed by digits).
For multiple distinct IDs, requestedSourceIds lists the requested IDs in request order.
With --needs-refresh, include only stale or undated selected sources and sources whose
IDs are referenced by selected issues; v and selected issues are preserved.
With --with-takeaways, select only sources with at least one nonblank takeaway;
this composes with --needs-refresh and preserves v and selected issues.
With --query, select sources whose title or retained takeaway contains the nonblank
text as a case-insensitive literal substring. Whitespace is significant. Issues are
scoped to matching source IDs, including all issues for a matching duplicate ID.
This searches the local digest only; no semantic or code index or network is used.
With --refresh-plan (requires --json), add refreshPlan entries for selected sources
needing attention: {sourceId, url, reasons}. URLs are existing Source citations;
null means no citation is available. Reasons are stale, undated, or
invalid_or_duplicate_metadata. Duplicate source/URL pairs merge their reasons.
Entries follow source and citation order; issues without a source follow in issue order.
Issues remain unchanged; duplicate-ID issues apply to every selected matching record.
With --check, exit 0 for a non-empty selection with all sources fresh and no issues;
exit 1 for an empty selection, an ID absent from the digest, stale or undated sources,
issues, or read failure. Requested IDs are checked before takeaway filtering.
The check evaluates the selection before --needs-refresh, after --source,
--with-takeaways and --query. Without --query, issues remain scoped by --source
and are not filtered by takeaways.
With --text, print one line per selected takeaway \u2014 source ID, checked date (or
undated), text \u2014 capped at 200 lines with a trailing count of any elided
takeaways. Displayed fields are stripped of terminal control characters, and
the date is colored by freshness only when stdout is a TTY.
With --compare-file <previous.md>, require --file and --json; reject --text,
--check, --source, --query, --needs-refresh, --with-takeaways and --refresh-plan. Both files use
bounded stable reads. Compare retained parser content by exact source ID and text;
ordering alone and computed staleness do not count as changes. Date-only changes
are citation_date changes, never new takeaways. Added/removed sources include their
respective added/removed takeaways. Duplicate or malformed IDs are ambiguous:
retain all their records separately and exclude them from inferred changes.
Both inputs' parser issues and takeaway truncation flags are preserved. Differences
beyond the reader's takeaway limits cannot be detected. No URLs are fetched.
Invalid arguments exit 2. Without --check, a successfully read digest exits 0.
Options: --file <markdown>  Input file; --json | --text  Required output mode;
         --source <id>  Exact source ID (repeatable); --stale-days <n>  Non-negative integer;
         --query <text>  Literal title or takeaway substring (case-insensitive);
         --needs-refresh  Filter sources;
         --with-takeaways  Filter sources to those with takeaways;
         --refresh-plan  Add a local citation revisit list (JSON only);
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
