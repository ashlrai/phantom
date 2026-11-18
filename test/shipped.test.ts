import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdShipped } from '../src/cli/shipped.js';
import {
  areaOf, buildShipped, gitShippedSource, shippedMarkdown, shippedText, type MergedChange, type ShippedSourceRead,
} from '../src/core/release/shipped.js';
import { handleShippedApi } from '../src/core/verse/whats-new-api.js';

const MIXED: MergedChange[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/shipped/mixed-week.json', import.meta.url)), 'utf8'));
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
      source: 'ok', note: null, total: 0, maintenance: 0, areas: [],
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
    expect(report.areas[0]!.lines[0]).toEqual({ text: 'Add a Shipped card to Home.', number: 108, mergedAt: '2026-11-16T12:00:00.000Z' });
    expect(shippedText(report).slice(0, 4)).toEqual([
      '8 changes shipped in the last 7 days, plus 2 maintenance changes.', '', 'Desktop app (2)', '  Add a Shipped card to Home. (#108)',
    ]);
    expect(JSON.stringify(report)).not.toMatch(/RQ-|bridge\(|older change/);
  });

  it('maintenance-only week: counts them and lists nothing', () => {
    const report = week(MIXED.filter(change => change.number === 109 || change.number === 110));
    expect(report).toMatchObject({ total: 2, maintenance: 2, areas: [] });
    expect(shippedText(report)).toEqual(['0 changes shipped in the last 7 days, plus 2 maintenance changes.']);
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
  });
});

describe('shippedMarkdown', () => {
  it('keeps a stable heading and a generated-by note', () => {
    const page = shippedMarkdown(week(MIXED));
    expect(page.startsWith('# What shipped\n\n<!-- generated by phm shipped (shipped.v1); do not edit by hand -->\n')).toBe(true);
    expect(page).toContain('Generated by `phm shipped --md`; run it again to refresh this page.');
    expect(page).toContain('Covers the 7 days ending 2026-11-17. 8 changes shipped in the last 7 days, plus 2 maintenance changes.');
    expect(page).toContain('## Desktop app\n\n- Add a Shipped card to Home. (#108)\n- Restore the window size after restart. (#102)\n');
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
    expect((await run([])).out.split('\n')[0]).toBe('8 changes shipped in the last 7 days, plus 2 maintenance changes.');
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

  it('exits 2 on bad usage and 0 on --help', async () => {
    for (const args of [['--since', '7h'], ['--since', '0d'], ['--json', '--md'], ['--nope']]) expect((await run(args)).code).toBe(2);
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
      { title: 'feat(cli): add phm shipped (#7)', number: 7, mergedAt: '2026-11-16T10:00:00Z', paths: ['src/cli/shipped.ts'] },
      { title: 'first', number: null, mergedAt: '2026-11-16T10:00:00Z', paths: [] },
    ]);
    expect(buildShipped(read, { now: NOW, days: 7 }).areas.map(area => area.id)).toEqual(['cli', 'unknown']);
    expect(await gitShippedSource(temp())(0)).toMatchObject({ state: 'unknown', changes: [] });
  });
});
