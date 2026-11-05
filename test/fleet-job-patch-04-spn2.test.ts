import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobPatch } from '../src/cli/fleet-job-patch.js';
import { jobPatch } from '../src/core/fleet/job-patch.js';

it('reads only the latest exact job patch from the pinned master snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-patch-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (subject: string) => { git('add', '-A'); git('commit', '-m', subject); };
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'a[1].txt'), 'old\n'); commit('bridge(RQ-TEST): initial (#1)');
    writeFileSync(join(dir, 'a[1].txt'), 'new\n');
    writeFileSync(join(dir, 'a1.txt'), 'other\n');
    writeFileSync(join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    commit('bridge(RQ-TEST): latest (#2)');
    const latest = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'noise'), 'noise'); commit('unrelated');
    writeFileSync(join(dir, 'noise'), 'lookalike'); commit('bridge(RQ-TEST-EXTRA): other (#3)');
    const snapshot = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/master', snapshot);
    process.chdir(dir);
    const result = await jobPatch('RQ-TEST', 'a[1].txt');
    expect(result).toMatchObject({ status: 'found', resolvedRef: snapshot, commit: latest, pr: 2, scanned: 4, matchesTruncated: true });
    expect(result.patch).toContain('-old\n+new');
    expect(result.patch).not.toContain('a1.txt');
    const all = await jobPatch('RQ-TEST');
    expect(all.patch).toContain('Binary files');
    expect(all.patch).not.toContain('\0');
    expect((await jobPatch('RQ-MISSING')).status).toBe('not-found-in-bounded-scan');
    expect(await cmdFleetJobPatch(['RQ-TEST', '--path', 'a1.txt', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).patch).not.toContain('a[1].txt');
    expect(await cmdFleetJobPatch(['RQ-TEST', '--path', 'noise'])).toBe(1);
    for (const args of [[], ['RQ-TEST', '--ref', 'HEAD'], ['RQ-TEST', '--json', '--json'], ['RQ-TEST', '--path', '../a'], ['RQ-TEST', '--path', '/a'], ['RQ-TEST', '--path', 'a/./b']]) {
      expect(await cmdFleetJobPatch(args)).toBe(2);
    }
    writeFileSync(join(dir, 'large'), 'é'.repeat(50000)); commit('bridge(RQ-LARGE): large (#4)');
    git('update-ref', 'refs/remotes/origin/master', git('rev-parse', 'HEAD'));
    const large = await jobPatch('RQ-LARGE');
    expect(large.patchTruncated).toBe(true);
    expect(Buffer.byteLength(large.patch)).toBeLessThanOrEqual(65536);
    expect(large.patch).not.toContain('\uFFFD');
    git('update-ref', '-d', 'refs/remotes/origin/master');
    expect(await cmdFleetJobPatch(['RQ-TEST'])).toBe(1);
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
