import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdSelf } from '../src/cli/self.js';
import { UNAVAILABLE_BUILD_IDENTITY, type BuildIdentity } from '../src/core/build-identity.js';
import { SELF_DRIFT_SCHEMA, formatSelfDrift, narrowSelfDrift, parseMergedPrs, readSelfDrift, touchesFleet } from '../src/core/release/drift.js';

const NOW = () => new Date('2026-11-18T12:00:00Z');
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A small real clone: one commit per call, tags, and origin/master pointed at HEAD. */
function clone() {
  const repo = mkdtempSync(join(tmpdir(), 'drift-'));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const commit = (subject: string, path: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${subject}\n`);
    git('add', '-A'); git('commit', '-qm', subject); git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    return git('rev-parse', 'HEAD');
  };
  return { repo, git, commit };
}
const built = (revision: string): () => BuildIdentity => () => ({ schemaVersion: 1, packageVersion: '3.1.0', revision, dirty: false, provenance: 'git' });

describe('phm self drift', () => {
  it('up to date: the running commit is master and the latest release', async () => {
    const { repo, git, commit } = clone();
    const head = commit('first (#1)', 'docs/a.md'); git('tag', 'v3.1.0'); git('tag', 'v3.2.0-beta');
    expect(await readSelfDrift({ repo, identity: built(head), now: NOW })).toEqual({
      schema: SELF_DRIFT_SCHEMA, version: 1, checkedAt: '2026-11-18T12:00:00.000Z', running: { version: '3.1.0', revision: head },
      running_sha: head, master_sha: head, behind: 0, missing_prs: [],
      latestRelease: { tag: 'v3.1.0', behind: 0 }, master: { revision: head, behind: 0 }, mergedPrs: 0, fleetFixes: [],
      status: 'up to date', unknownReason: null, updateCommand: 'phm update', line: 'Running build is up to date.',
    });
  });

  it('behind master but on the latest release: says so, and lists only fleet-touching merged PRs', async () => {
    const { repo, git, commit } = clone();
    const running = commit('first (#1)', 'docs/a.md'); git('tag', 'v3.1.0');
    commit('fix: queue order (#2)', 'src/core/plain.ts');          // fleet word in the title
    commit('fix: tidy names (#3)', 'src/core/fleet/dispatch.ts');  // fleet word in a path
    commit('docs: readme (#4)', 'docs/b.md');                      // neither
    commit('fix: leader note', 'docs/c.md');                       // no PR number: not a merged PR
    const drift = await readSelfDrift({ repo, identity: built(running), now: NOW });
    expect(drift).toMatchObject({ latestRelease: { tag: 'v3.1.0', behind: 0 }, master: { behind: 4 }, behind: 4, missing_prs: [{ pr: 4, title: 'docs: readme' }, { pr: 3, title: 'fix: tidy names' }, { pr: 2, title: 'fix: queue order' }], mergedPrs: 3, status: 'behind',
      fleetFixes: [{ pr: 3, title: 'fix: tidy names' }, { pr: 2, title: 'fix: queue order' }],
      line: 'Running build is 4 fixes behind. Restart to update.' });
    expect(narrowSelfDrift(JSON.parse(JSON.stringify(drift)))).not.toBeNull();
    const text = formatSelfDrift(drift);
    expect(text.split('\n')[0]).toBe(drift.line);
    expect(text).toContain('latest release  v3.1.0: up to date');
    expect(text).toContain('  #3 fix: tidy names\n  #2 fix: queue order\n');
  });

  it('behind both the latest release and master', async () => {
    const { repo, git, commit } = clone();
    const running = commit('first (#1)', 'docs/a.md'); git('tag', 'v3.0.0');
    commit('fix: recut skip (#2)', 'docs/b.md'); commit('docs: two (#3)', 'docs/c.md'); git('tag', 'v3.1.0');
    commit('docs: three (#4)', 'docs/d.md');
    expect(await readSelfDrift({ repo, identity: built(running), now: NOW })).toMatchObject({ latestRelease: { tag: 'v3.1.0', behind: 2 }, master: { behind: 3 }, mergedPrs: 3,
      line: 'Running build is 3 fixes behind. Restart to update.' });
  });

  it('the fleet filter reads titles and paths, and merge commits count as merged PRs', async () => {
    const prs = parseMergedPrs('\x1eMerge pull request #7 from a/b\n\nsrc/core/router/pick.ts\n\x1efeat: home card (#6)\n\nsrc/web-ui/home.tsx\n\x1eno number\n\nsrc/x.ts\n');
    expect(prs).toEqual([{ pr: 7, title: 'Merge pull request #7 from a/b', paths: ['src/core/router/pick.ts'] }, { pr: 6, title: 'feat: home card', paths: ['src/web-ui/home.tsx'] }]);
    expect(prs.map(touchesFleet)).toEqual([true, false]);
    for (const word of ['queue', 'dispatch', 'recut', 'precheck', 'router', 'yield', 'Leader']) expect(touchesFleet({ title: `fix ${word}`, paths: [] })).toBe(true);
    expect(touchesFleet({ title: 'fix: typo', paths: ['docs/guide.md'] })).toBe(false);
  });

  it('unknown metadata is unknown, never zero: no build commit, no clone, a commit the clone lacks, a shallow clone', async () => {
    const { repo, commit } = clone();
    const first = commit('first (#1)', 'docs/a.md'); commit('fix: queue (#2)', 'docs/b.md'); commit('docs: c (#3)', 'docs/c.md');
    const unknown = { behind: 'unknown', missing_prs: 'unknown', master: { behind: 'unknown' }, mergedPrs: 'unknown', fleetFixes: 'unknown', status: 'unknown' };
    const none = await readSelfDrift({ repo, identity: () => ({ ...UNAVAILABLE_BUILD_IDENTITY }), now: NOW });
    expect(none).toMatchObject({ ...unknown, running: { version: 'unknown', revision: 'unknown' }, latestRelease: { tag: 'unknown', behind: 'unknown' },
      line: 'Running build: unknown (this build has no recorded commit).' });
    expect(formatSelfDrift(none)).toContain('running         unknown (unknown)');
    expect(await readSelfDrift({ git: async () => null, identity: built(first), now: NOW })).toMatchObject({ ...unknown, master: { revision: 'unknown', behind: 'unknown' }, unknownReason: 'origin/master is not readable in the local clone' });
    expect(await readSelfDrift({ repo, identity: built('absent'), now: NOW })).toMatchObject({ ...unknown, unknownReason: 'the local clone does not have the running commit' });
    // A shallow clone still counts when master contains the running commit, and refuses when the history is cut.
    const shallow = mkdtempSync(join(tmpdir(), 'drift-')); dirs.push(shallow);
    execFileSync('git', ['clone', '-q', '--depth', '2', `file://${repo}`, shallow]);
    execFileSync('git', ['-C', shallow, 'update-ref', 'refs/remotes/origin/master', 'HEAD']);
    const tip = execFileSync('git', ['-C', shallow, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
    expect(await readSelfDrift({ repo: shallow, identity: built(tip), now: NOW })).toMatchObject({ master: { behind: 1 }, mergedPrs: 1, fleetFixes: [] });
    execFileSync('git', ['-C', shallow, 'fetch', '-q', '--depth', '1', `file://${repo}`, first]);
    expect(await readSelfDrift({ repo: shallow, identity: built(first), now: NOW })).toMatchObject({ ...unknown, unknownReason: 'the local clone history is too short' });
  });

  it('a failed or empty count is unknown, and a failed PR read does not invent an empty list', async () => {
    const git = async (args: readonly string[]) => {
      if (args[0] === 'rev-parse') return args.includes('--is-shallow-repository') ? 'false' : 'master';
      return '';
    };
    const unreadable = await readSelfDrift({ git, identity: built('running'), now: NOW });
    expect(unreadable).toMatchObject({ behind: 'unknown', missing_prs: 'unknown', unknownReason: 'the local clone history could not be read' });
    const report = await readSelfDrift({ git: async args => args[0] === 'rev-list' ? '3' : args[0] === 'log' ? null : git(args), identity: built('running'), now: NOW });
    expect(report).toMatchObject({ running_sha: 'running', master_sha: 'master', behind: 3, missing_prs: 'unknown' });
    expect(narrowSelfDrift(report)).toEqual({ behind: 3, line: 'Running build is 3 fixes behind. Restart to update.' });
    for (const behind of [-1, 0.5, null, 'three']) expect(narrowSelfDrift({ ...report, behind })).toBeNull();
  });

  it('--json prints schema and version; human output leads with the line; bad usage exits 2', async () => {
    const { repo, commit } = clone();
    const running = commit('first (#1)', 'docs/a.md'); commit('fix: yield stop (#2)', 'docs/b.md');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const read = (dir?: string) => readSelfDrift({ repo: dir, identity: built(running), now: NOW });
    expect(await cmdSelf(['drift', '--json', '--repo', repo], read)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ schema: 'phantom.self-drift.v1', version: 1, running: { version: '3.1.0', revision: running },
      running_sha: running, behind: 1, missing_prs: [{ pr: 2, title: 'fix: yield stop' }], master: { behind: 1 }, fleetFixes: [{ pr: 2, title: 'fix: yield stop' }], updateCommand: 'phm update' });
    expect(await cmdSelf(['drift', '--repo', repo], read)).toBe(0);
    expect(String(write.mock.calls[0]![0])).toMatch(/^Running build is 1 fix behind\. Restart to update\.\n/);
    expect(await cmdSelf(['--help'])).toBe(0);
    expect(String(out.mock.calls[1]![0])).toContain('Usage: phm self drift');
    for (const bad of [[], ['other'], ['drift', '--nope'], ['drift', '--repo']]) expect(await cmdSelf(bad, read)).toBe(2);
    expect(err).toHaveBeenCalledTimes(4);
  });
});
