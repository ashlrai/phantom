import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdShipped } from '../src/cli/shipped.js';
import {
  areaOf, buildShipped, gitShippedSource, recordsShippedSource, shippedMarkdown, shippedText, type MergedChange, type ShippedReport, type ShippedSourceRead,
} from '../src/core/release/shipped.js';
import { shippedItems, shippedPage } from '../src/core/release/shipped-page.js';
import { handleShippedApi } from '../src/core/verse/whats-new-api.js';

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const MIXED: MergedChange[] = JSON.parse(readFileSync(file('./fixtures/shipped/mixed-week.json'), 'utf8'));
/** Merged pull request records from three repositories, in the shape the daily job collects. */
const FLEET = file('./fixtures/shipped/fleet-week.json');
const fleet = (opts: { repo?: string; maxLines?: number } = {}) => buildShipped(recordsShippedSource(readFileSync(FLEET, 'utf8')), { now: NOW, days: 7, ...opts });
const TOP = 'This week: 8 user-facing changes across 1 repo; biggest: Add a Shipped card to Home.';
const LEFT_OUT = 'Not listed: 2 maintenance changes (tests, chores, fixups, reverts).';
const NOW = Date.parse('2026-11-17T00:00:00Z');
const ok = (changes: MergedChange[]): ShippedSourceRead => ({ state: 'ok', note: null, changes });
const week = (changes: MergedChange[]) => buildShipped(ok(changes), { now: NOW, days: 7 });
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'shipped-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('buildShipped', () => {
  it('empty week: zero counts, no areas, and says so in plain words', () => {
    const report = week([]);
    expect(report).toEqual({
      schema: 'shipped.v1', version: 1, generatedAt: '2026-11-17T00:00:00.000Z', since: '2026-11-10T00:00:00.000Z', days: 7,
      source: 'ok', note: null, repo: null, headline: 'Nothing merged in the last 7 days.', repos: 0, biggest: null, total: 0, maintenance: 0, areas: [],
    });
    expect(shippedText(report)).toEqual(['Nothing merged in the last 7 days.']);
  });

  it('mixed week: groups by product area in a fixed order, newest first, one plain sentence each', () => {
    const report = week(MIXED);
    expect(report.total).toBe(10);
    expect(report.maintenance).toBe(2);
    expect(report.areas.map(area => [area.label, area.count, area.lines.map(line => line.text)])).toEqual([
      // #108 is a recut of #101: one change, not two.
      ['Desktop app', 2, ['Add a Shipped card to Home.', 'Restore the window size after restart.']],
      ['CLI', 1, ['Add phm shipped.']],
      ['Fleet', 1, ['Show held lanes in the roster.']],
      ['Channels', 1, ['Telegram replies keep their thread.']],
      ['Docs', 1, ['Explain the update channel.']],
      ['Everything else', 1, ['Speed up the index build.']],
      ['Area unknown', 1, ['Tidy the merge path.']],
    ]);
    expect(report.areas[0]!.lines[0]).toEqual({ text: 'Add a Shipped card to Home.', number: 108, mergedAt: '2026-11-16T12:00:00.000Z', repo: null, prs: [108, 101] });
    expect(shippedText(report).slice(0, 5)).toEqual([TOP, LEFT_OUT, '', 'Desktop app (2)', '  Add a Shipped card to Home. (#108, #101)']);
    expect(JSON.stringify(report)).not.toMatch(/RQ-|bridge\(|older change/);
  });

  it('maintenance-only week: counts them and lists nothing', () => {
    const report = week(MIXED.filter(change => change.number === 109 || change.number === 110));
    expect(report).toMatchObject({ total: 2, maintenance: 2, areas: [] });
    expect(shippedText(report)).toEqual(['This week: no user-facing changes.', LEFT_OUT]);
  });

  it('is deterministic: the same input in any order gives the same JSON and the same page', () => {
    const first = week(MIXED), second = week([...MIXED].reverse());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(shippedMarkdown(second)).toBe(shippedMarkdown(first));
  });

  it('an unreadable source is unknown, never zero; long areas are capped with the full count kept', () => {
    const unknown = buildShipped({ state: 'unknown', note: 'No git history could be read here.', changes: MIXED }, { now: NOW, days: 7 });
    expect(unknown).toMatchObject({ source: 'unknown', total: null, maintenance: null, areas: [] });
    expect(shippedText(unknown)).toEqual(['Unknown: what shipped in the last 7 days could not be read.', 'No git history could be read here.']);
    const many = week(Array.from({ length: 11 }, (_, i) => ({ title: `Improve step ${i}`, number: i + 1, mergedAt: '2026-11-16T00:00:00Z', paths: ['src/cli/a.ts'] })));
    expect(many.areas).toMatchObject([{ id: 'cli', count: 11 }]);
    expect(many.areas[0]!.lines).toHaveLength(8);
    expect(shippedText(many).at(-1)).toBe('  and 3 more');
  });

  it('picks the area holding most product paths and ignores test paths', () => {
    expect(areaOf(['src/cli/fleet-status.ts', 'src/cli/help.ts', 'src/cli/index.ts'])).toBe('cli');
    expect(areaOf(['src/core/verse/a.ts', 'test/a.test.ts', 'test/b.test.ts'])).toBe('desktop');
    expect(areaOf(['README.md'])).toBe('docs');
    expect(areaOf([])).toBe('unknown');
    expect(areaOf(['src/web-ui/routes/verse/mobile/screens/HomeScreen.tsx'])).toBe('mobile');
    expect(areaOf(['src/core/mcp/tools.ts', 'plugins/a/index.ts'])).toBe('plugins');
    // Paths this map does not know: a label names the area, then the repository does. Known paths always win.
    expect(areaOf(['lib/a.ts'], { repo: 'ashlrai/ashlr-plugin', labels: ['mobile'] })).toBe('mobile');
    expect(areaOf(['lib/a.ts'], { repo: 'ashlrai/ashlr-plugin' })).toBe('plugins');
    expect(areaOf(['src/cli/a.ts'], { repo: 'ashlrai/ashlr-plugin', labels: ['mobile'] })).toBe('cli');
    expect(areaOf(['lib/a.ts'], { repo: 'ashlrai/phantom' })).toBe('other');
  });
});

describe('buildShipped across repositories', () => {
  it('mixed week: one top line, areas named from paths, labels and repositories, noise left out', () => {
    const report = fleet();
    expect(report).toMatchObject({ schema: 'shipped.v1', version: 1, source: 'ok', repo: null, repos: 3, total: 13, maintenance: 7, biggest: 'Live agent map in 3D' });
    expect(report.headline).toBe('This week: 6 user-facing changes across 3 repos; biggest: Live agent map in 3D.');
    expect(report.areas.map(area => [area.label, area.lines.map(line => `${line.repo} ${line.text}`)])).toEqual([
      ['Desktop app', ['ashlrai/phantom Live agent map in 3D.']],
      ['Mobile', ['ashlrai/phantom Phone inbox shows approvals.']],
      ['Fleet', ['ashlrai/phantom Keep the roster sorted.']],
      // The revert of a revert puts "quiet mode" back; the reverted banner, the fixup, the bump and the test change are gone.
      ['Plugins', ['ashlrai/ashlr-plugin Add a savings badge.', 'ashlrai/ashlr-plugin Add a quiet mode.']],
      ['Docs', ['ashlrai/ashlr-md Faster preview for long notes.']],
    ]);
    expect(JSON.stringify(report)).not.toMatch(/banner|FIXUP|Bump|Revert|More cases/);
    expect(shippedText(report)).toContain('  Add a savings badge. (ashlr-plugin #40)');
  });

  it('two pull requests on the same feature are one line that names both', () => {
    const map = fleet().areas[0]!.lines[0]!;
    expect(map).toEqual({ text: 'Live agent map in 3D.', number: 205, mergedAt: '2026-11-15T10:00:00.000Z', repo: 'ashlrai/phantom', prs: [205, 201] });
    expect(shippedText(fleet())).toContain('  Live agent map in 3D. (phantom #205, #201)');
    // The same number in two repositories is two changes, never a recut of one another.
    expect(fleet().areas.flatMap(area => area.lines).filter(line => line.number === 5).map(line => line.repo)).toEqual(['ashlrai/phantom', 'ashlrai/ashlr-md']);
  });

  it('--repo keeps one repository, by full or short name; a name nothing matches is an empty week', () => {
    const plugin = fleet({ repo: 'ashlr-plugin' });
    expect(plugin).toMatchObject({ repo: 'ashlr-plugin', repos: 1, total: 4, maintenance: 2, headline: 'This week: 2 user-facing changes across 1 repo; biggest: Add a savings badge.' });
    expect(JSON.stringify(fleet({ repo: 'AshlrAI/Ashlr-Plugin' }).areas)).toBe(JSON.stringify(plugin.areas));
    expect(fleet({ repo: 'plugin' })).toMatchObject({ total: 0, repos: 0, areas: [], headline: 'Nothing merged in the last 7 days.' });
  });

  it('records: a file that is not a list is unknown; records that cannot be read make the report partial', () => {
    expect(recordsShippedSource('{')).toEqual({ state: 'unknown', note: 'The merged pull request file is not a JSON list.', changes: [] });
    expect(recordsShippedSource('[]')).toEqual({ state: 'ok', note: null, changes: [] });
    const read = recordsShippedSource(JSON.stringify([{ repo: 'a/b', number: 1, title: 'Add a thing', merged_at: '2026-11-16T00:00:00Z' }, { title: 'No date' }, null]));
    expect(read).toEqual({ state: 'partial', note: '2 records could not be read and were left out.',
      changes: [{ title: 'Add a thing', number: 1, mergedAt: '2026-11-16T00:00:00Z', repo: 'a/b', labels: [], paths: [] }] });
    // No files were given, so the area is unknown rather than guessed.
    expect(buildShipped(read, { now: NOW, days: 7 }).areas.map(area => area.id)).toEqual(['unknown']);
  });
});

describe('the website page', () => {
  const li = (page: string) => page.match(/<li>/g)?.length ?? 0;

  it('normal: the top line and every change, newest first, as plain HTML with no script', () => {
    const report = fleet({ maxLines: 30 });
    const page = shippedPage(report);
    expect(page).toContain('<p class="lead">This week: 6 user-facing changes across 3 repos; biggest: Live agent map in 3D.</p>');
    expect(page).toContain('<p class="muted">Not listed: 7 maintenance changes (tests, chores, fixups, reverts).</p>');
    expect(shippedItems(report).map(item => item.number)).toEqual([40, 205, 5, 202, 5, 41]);
    expect(page).toContain('<li><time datetime="2026-11-16T08:00:00.000Z">2026-11-16</time><span class="area">Plugins</span><span class="ref">ashlrai/ashlr-plugin #40</span><p class="item">Add a savings badge.</p></li>');
    expect(li(page)).toBe(6);
    expect(page).toContain('<link rel="canonical" href="https://verse.ashlr.ai/shipped">');
    expect(page).not.toMatch(/<script|fetch\(/);
    expect(shippedPage(fleet({ maxLines: 30 }))).toBe(page);
  });

  it('empty and unknown: says so, lists nothing', () => {
    const empty = shippedPage(week([]));
    expect(empty).toContain('<p class="lead">Nothing merged in the last 7 days.</p>');
    expect(empty).toContain('<p class="muted">Nothing shipped yet this week.</p>');
    expect(li(empty)).toBe(0);
    const unknown = shippedPage(buildShipped(recordsShippedSource('nope'), { now: NOW, days: 7 }));
    expect(unknown).toContain('Unknown: what shipped in the last 7 days could not be read.');
    expect(unknown).toContain('The merged pull request file is not a JSON list.');
  });

  it('lists the newest 30 only, and never lets a title write markup', () => {
    const many = Array.from({ length: 35 }, (_, i) => ({ title: `Improve <b>step</b> ${i}`, number: i + 1, mergedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(), paths: ['src/cli/a.ts'] }));
    const page = shippedPage(buildShipped(ok(many), { now: NOW, days: 7, maxLines: 30 }));
    expect(li(page)).toBe(30);
    expect(page).toContain('Showing the newest 30 of 35 changes.');
    expect(page).toContain('Improve &#60;b&#62;step&#60;/b&#62; 0.');
    expect(page).not.toContain('<b>');
  });

  it('the checked-in page is exactly the checked-in JSON, rendered', () => {
    const report = JSON.parse(readFileSync(file('../site/shipped.json'), 'utf8')) as ShippedReport;
    expect(report).toMatchObject({ schema: 'shipped.v1', version: 1 });
    expect(readFileSync(file('../site/shipped.html'), 'utf8')).toBe(shippedPage(report));
  });
});

describe('shippedMarkdown', () => {
  it('keeps a stable heading and a generated-by note', () => {
    const page = shippedMarkdown(week(MIXED));
    expect(page.startsWith('# What shipped\n\n<!-- generated by phm shipped (shipped.v1); do not edit by hand -->\n')).toBe(true);
    expect(page).toContain('Generated by `phm shipped --md`; run it again to refresh this page.');
    expect(page).toContain(`Covers the 7 days ending 2026-11-17. ${TOP}\n\n${LEFT_OUT}\n`);
    expect(page).toContain('## Desktop app\n\n- Add a Shipped card to Home. (#108, #101)\n- Restore the window size after restart. (#102)\n');
    expect(page.endsWith('- Tidy the merge path.\n')).toBe(true);
  });
});

describe('phm shipped', () => {
  const run = async (args: string[], read: ShippedSourceRead = ok(MIXED), root = '/nonexistent') => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdShipped(args, { now: () => NOW, out: line => out.push(line), err: line => err.push(line), root, source: () => read });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints text by default and the versioned report with --json', async () => {
    expect((await run([])).out.split('\n')[0]).toBe(TOP);
    const json = await run(['--json', '--since', '30d']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'shipped.v1', version: 1, days: 30, total: 11 });
  });

  it('--md writes docs/SHIPPED.md and prints its path; an unknown source leaves the page alone', async () => {
    const root = temp();
    const written = await run(['--md'], ok(MIXED), root);
    expect(written).toMatchObject({ code: 0, out: join(root, 'docs/SHIPPED.md') });
    expect(readFileSync(join(root, 'docs/SHIPPED.md'), 'utf8')).toBe(shippedMarkdown(week(MIXED)));
    const failed = await run(['--md'], { state: 'unknown', note: 'No git history could be read here.', changes: [] }, root);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('docs/SHIPPED.md was not changed');
    expect(readFileSync(join(root, 'docs/SHIPPED.md'), 'utf8')).toBe(shippedMarkdown(week(MIXED)));
  });

  it('--from reads merged pull requests for several repositories; --repo narrows them; a missing file is unknown', async () => {
    const from = async (...args: string[]) => {
      const out: string[] = [];
      const code = await cmdShipped(['--from', ...args], { now: () => NOW, out: line => out.push(line), err: () => undefined, root: '/nonexistent' });
      return { code, out: out.join('\n') };
    };
    expect(JSON.parse((await from(FLEET, '--json')).out)).toEqual(fleet());
    expect(JSON.parse((await from(FLEET, '--json', '--repo', 'ashlrai/ashlr-md')).out)).toMatchObject({ repo: 'ashlrai/ashlr-md', total: 1, repos: 1 });
    expect(await from(join(temp(), 'none.json'))).toEqual({ code: 1, out: 'Unknown: what shipped in the last 7 days could not be read.\nThe merged pull request file could not be read.' });
  });

  it('--site writes the JSON and the page built from it; an unknown source leaves both alone', async () => {
    const root = temp();
    const written = await run(['--site'], recordsShippedSource(readFileSync(FLEET, 'utf8')), root);
    expect(written).toMatchObject({ code: 0, out: `${join(root, 'site/shipped.json')}\n${join(root, 'site/shipped.html')}` });
    const report = JSON.parse(readFileSync(join(root, 'site/shipped.json'), 'utf8')) as ShippedReport;
    expect(report).toEqual(fleet({ maxLines: 30 }));
    expect(readFileSync(join(root, 'site/shipped.html'), 'utf8')).toBe(shippedPage(report));
    const failed = await run(['--site'], { state: 'unknown', note: 'No git history could be read here.', changes: [] }, root);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('site/shipped.json and site/shipped.html were not changed');
    expect(JSON.parse(readFileSync(join(root, 'site/shipped.json'), 'utf8'))).toEqual(report);
  });

  it('exits 2 on bad usage and 0 on --help', async () => {
    for (const args of [['--since', '7h'], ['--since', '0d'], ['--json', '--md'], ['--md', '--site'], ['--repo'], ['--from', '--json'], ['--nope']]) expect((await run(args)).code).toBe(2);
    expect(await run(['--help'])).toMatchObject({ code: 0, out: expect.stringContaining('Usage: phm shipped') });
  });
});

describe('GET /api/verse/shipped', () => {
  const call = async (url: string, method = 'GET') => {
    let status = 0, body: unknown;
    const res = { writeHead: (code: number) => { status = code; }, setHeader: () => undefined, end: (text: string) => { body = JSON.parse(text); } } as unknown as ServerResponse;
    await handleShippedApi({ url } as IncomingMessage, res, method, { source: () => ok(MIXED), now: () => NOW });
    return { status, body };
  };

  it('serves the same report as the CLI and rejects bad input', async () => {
    expect(await call('/api/verse/shipped')).toEqual({ status: 200, body: week(MIXED) });
    expect((await call('/api/verse/shipped?days=30')).body).toMatchObject({ days: 30, total: 11 });
    expect((await call('/api/verse/shipped?days=0')).status).toBe(400);
    expect((await call('/api/verse/shipped?days=x')).status).toBe(400);
    expect((await call('/api/verse/shipped', 'POST')).status).toBe(405);
  });
});

describe('gitShippedSource', () => {
  it('reads titles, PR numbers, times and paths from local history; a non-repository is unknown', async () => {
    const root = temp();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-16T10:00:00Z', GIT_AUTHOR_DATE: '2026-11-16T10:00:00Z' } });
    git('init', '-q', '-b', 'master');
    writeFileSync(join(root, 'README.md'), 'one\n');
    git('add', '.'); git('commit', '-q', '-m', 'first');
    mkdirSync(join(root, 'src/cli'), { recursive: true });
    writeFileSync(join(root, 'src/cli/shipped.ts'), 'export {};\n');
    git('add', '.'); git('commit', '-q', '-m', 'feat(cli): add phm shipped (#7)');
    const read = await gitShippedSource(root)(NOW - 7 * 86_400_000);
    expect(read.state).toBe('ok');
    expect(read.changes).toEqual([
      { title: 'feat(cli): add phm shipped (#7)', number: 7, mergedAt: '2026-11-16T10:00:00Z', paths: ['src/cli/shipped.ts'], repo: null },
      { title: 'first', number: null, mergedAt: '2026-11-16T10:00:00Z', paths: [], repo: null },
    ]);
    expect(buildShipped(read, { now: NOW, days: 7 }).areas.map(area => area.id)).toEqual(['cli', 'unknown']);
    expect(await gitShippedSource(temp())(0)).toMatchObject({ state: 'unknown', changes: [] });
  });
});
