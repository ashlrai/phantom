import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdShipped } from '../src/cli/shipped.js';
import { bucketOf, buildHourShipped, findClones, hourShippedText, plainTitle, readHourShipped } from '../src/core/fleet/shipped-hour.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'shipped-hour-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A clone under `root` named `name` with squash-merge style commits: one file change each, at a given time. */
function clone(root: string, name: string, commits: Array<{ subject: string; file: string; minutesAgo: number }>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'a@example.com'); git('config', 'user.name', 'Fixture');
  git('remote', 'add', 'origin', `https://example.com/acme/${name}.git`);
  for (const [i, c] of commits.entries()) {
    mkdirSync(dirname(join(dir, c.file)), { recursive: true });
    writeFileSync(join(dir, c.file), `change ${i}\n`);
    git('add', '-A');
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', c.subject], { env: { ...process.env, GIT_AUTHOR_DATE: at(c.minutesAgo), GIT_COMMITTER_DATE: at(c.minutesAgo) } });
  }
  return dir;
}

describe('plainTitle', () => {
  it('strips the bridge prefix, conventional prefix and PR number', () => {
    expect(plainTitle('bridge(RQ-FOO-123): add a lane card (#42)', 42)).toBe('Add a lane card');
    expect(plainTitle('feat(web): show the roster (#7)', 7)).toBe('Show the roster');
    expect(plainTitle('Merge pull request #9 from acme/topic', 9)).toBe('Change #9');
  });
  it('an empty title falls back to the PR number', () => {
    expect(plainTitle('bridge(RQ-DEVINCLOUD-RQ-DVL-BUS-17): (#7761)', 7761)).toBe('Change #7761');
    expect(plainTitle('bridge:', null)).toBe('Change merged');
  });
});

describe('bucketOf', () => {
  it.each([
    [['src/core/fleet/status.ts'], 'Tidy status', 'fleet'],
    [['src/web-ui/routes/verse/home/HomePane.tsx'], 'Home line', 'desktop-phone'],
    [['src/web-ui/routes/verse/mobile/BriefTiles.tsx'], 'Phone line', 'desktop-phone'],
    [['docs/GUIDE.md', 'site/index.html'], 'Explain it', 'docs-site'],
    [['test/a.test.ts', 'test/fixtures/x.json'], 'More coverage', 'tests'],
    [['src/core/util/text.ts'], 'Speed up text', 'other'],
    [[], 'Fix the fleet lane roster', 'fleet'],
    [[], 'Polish the phone screen', 'desktop-phone'],
    [[], 'Refresh the website', 'docs-site'],
    [[], 'Something unrelated', 'other'],
  ] as const)('%j → %s', (paths, subject, bucket) => {
    expect(bucketOf([...paths], subject, 'acme/app')).toBe(bucket);
  });
});

describe('buildHourShipped', () => {
  it('empty hour says so in plain words and still counts as read', () => {
    const report = buildHourShipped([{ repo: 'acme/app', commits: [] }], NOW);
    expect(report).toMatchObject({ schema: 'fleet.shipped.v1', window: '1h', complete: true, total: 0, headline: 'Nothing shipped in the last hour.', items: [] });
    expect(hourShippedText(report)).toEqual(['Nothing shipped in the last hour.']);
  });
  it('unreadable clones are unknown, not zero', () => {
    const report = buildHourShipped([null], NOW);
    expect(report).toMatchObject({ complete: false, total: null });
    expect(report.headline).toMatch(/^Unknown/);
  });
  it('drops commits outside the hour and dedupes the same PR seen twice', () => {
    const commit = { sha: 'a', mergedAt: at(5), subject: 'Add a thing (#1)', paths: ['src/core/util/x.ts'] };
    const old = { sha: 'b', mergedAt: at(90), subject: 'Old thing (#2)', paths: [] };
    const report = buildHourShipped([{ repo: 'acme/app', commits: [commit, old] }, { repo: 'acme/app', commits: [commit] }], NOW);
    expect(report.items.map(i => i.number)).toEqual([1]);
  });
});

describe('readHourShipped over temp git repos', () => {
  it('buckets, strips prefixes and combines several repos, newest first', async () => {
    const root = temp();
    clone(root, 'app', [
      { subject: 'Something merged yesterday (#9)', file: 'src/core/util/old.ts', minutesAgo: 600 },
      { subject: 'bridge(RQ-ONE-1): Show held lanes in the roster (#10)', file: 'src/core/fleet/roster.ts', minutesAgo: 50 },
      { subject: 'bridge(RQ-TWO-2): Add an hour line to Home (#11)', file: 'src/web-ui/routes/verse/home/Line.tsx', minutesAgo: 30 },
      { subject: 'docs: explain the update channel (#12)', file: 'docs/UPDATES.md', minutesAgo: 20 },
      { subject: 'Cover the roster with tests (#13)', file: 'test/roster.test.ts', minutesAgo: 10 },
    ]);
    clone(root, 'tools', [{ subject: 'Fix the queue ordering (#3)', file: 'src/core/queue/order.ts', minutesAgo: 5 }]);
    mkdirSync(join(root, 'wt', 'job'), { recursive: true }); // job worktrees are not clones
    expect(findClones(root).map(p => p.split('/').pop())).toEqual(['app', 'tools']);

    const report = await readHourShipped({ now: NOW, roots: [root] });
    expect(report.complete).toBe(true);
    expect(report.total).toBe(5);
    expect(report.headline).toBe('Last hour: 5 shipped (2 fleet, 1 desktop/phone, 1 docs/site, 1 tests)');
    expect(report.items.map(i => [i.repo, i.title, i.bucket])).toEqual([
      ['acme/tools', 'Fix the queue ordering', 'fleet'],
      ['acme/app', 'Cover the roster with tests', 'tests'],
      ['acme/app', 'Explain the update channel', 'docs-site'],
      ['acme/app', 'Add an hour line to Home', 'desktop-phone'],
      ['acme/app', 'Show held lanes in the roster', 'fleet'],
    ]);
    expect(report.items.find(i => i.number === 10)!.jobId).toBe('RQ-ONE-1');
    expect(report.byRepo).toEqual({ 'acme/app': 4, 'acme/tools': 1 });
    expect(JSON.stringify(report)).not.toMatch(/bridge\(/);
  });

  it('reads real merge commits too', async () => {
    const root = temp();
    const dir = clone(root, 'app', [{ subject: 'Base (#1)', file: 'src/core/util/base.ts', minutesAgo: 120 }]);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: at(15), GIT_AUTHOR_DATE: at(15) } });
    git('checkout', '-q', '-b', 'topic');
    writeFileSync(join(dir, 'topic.txt'), 'x\n'); mkdirSync(join(dir, 'docs'), { recursive: true }); writeFileSync(join(dir, 'docs/topic.md'), 'x\n');
    git('add', '-A'); git('commit', '-q', '-m', 'topic work');
    git('checkout', '-q', 'master');
    git('merge', '--no-ff', '-q', '-m', 'Merge pull request #5 from acme/topic', 'topic');
    const report = await readHourShipped({ now: NOW, roots: [root] });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ number: 5, title: 'Change #5' });
  });

  it('no clones at all is unknown', async () => {
    expect((await readHourShipped({ now: NOW, roots: [temp()] })).complete).toBe(false);
  });
});

describe('phm shipped --since 1h', () => {
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const hour = () => readHourShipped({ now: NOW, roots: [root] });
    const code = await cmdShipped(args, { now: () => NOW, out: l => out.push(l), err: l => err.push(l), hour });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  let root = '';
  it('prints plain text and JSON from the same report', async () => {
    root = temp();
    clone(root, 'app', [{ subject: 'bridge(RQ-X-1): Show held lanes (#10)', file: 'src/core/fleet/roster.ts', minutesAgo: 5 }]);
    const text = await run(['--since', '1h']);
    expect(text.code).toBe(0);
    expect(text.out).toBe('Last hour: 1 shipped (1 fleet)\n\nfleet (1)\n  Show held lanes (app #10)');
    const json = JSON.parse((await run(['--since', '1h', '--json'])).out);
    expect(json).toMatchObject({ schema: 'fleet.shipped.v1', window: '1h', total: 1 });
  });
  it('empty hour exits 0 with the plain sentence; bad flags exit 2', async () => {
    root = temp();
    clone(root, 'app', [{ subject: 'Merged long ago (#1)', file: 'src/core/util/old.ts', minutesAgo: 600 }]);
    expect((await run(['--since', '1h'])).out).toBe('Nothing shipped in the last hour.');
    expect((await run(['--since', '1h', '--md'])).code).toBe(2);
  });
});

describe('leader brief line', () => {
  it('shows the hour line under the header, and nothing when it could not be read', async () => {
    const { composeBrief } = await import('../src/core/comms/leader-brief.js');
    const base = { nowMs: NOW, sinceMs: NOW - 3_600_000, shipped: [], prsOpened: 0, running: [], blockers: [], next: [], question: null, pendingActionIds: [] };
    const withLine = composeBrief('instant', { ...base, hourLine: 'Last hour: 2 shipped (2 fleet)' }).split('\n');
    expect(withLine[1]).toBe('Last hour: 2 shipped (2 fleet)');
    expect(composeBrief('instant', { ...base, hourLine: null })).not.toMatch(/Last hour/);
  });
});
