import { mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fleetPrerequisite, main } from '../scripts/fleet-prerequisite.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const job = 'RQ-FAKE-GATE';
const repo = 'example/project';
const expectedHead = 'a'.repeat(40);
const mergeOid = 'b'.repeat(40);
const url = 'https://github.com/example/project/pull/123';
const input = { job, repo, expectedHead };
const merged = { number: 123, url, state: 'MERGED', headRefOid: expectedHead, mergeCommit: { oid: mergeOid }, mergedAt: '2026-10-31T12:00:00Z' };
let runsDir: string;
let runner: ReturnType<typeof vi.fn<GitRunner>>;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'fleet-prerequisite-'));
  runner = vi.fn<GitRunner>().mockResolvedValue({ code: 0, stdout: JSON.stringify(merged), stderr: '', timedOut: false, truncated: false, missing: false });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(runsDir, { recursive: true, force: true }); });

async function publish(pr = url) { await writeFile(join(runsDir, `${job}.publish`), `RESULT PR ${pr}\nAUTO_MERGE on\n`); }
const check = () => fleetPrerequisite(input, { runner, detailOptions: { runsDir } });
function response(value: unknown) {
  runner.mockResolvedValue({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false });
}

describe('fleet merge prerequisite', () => {
  it('reads retained publication and releases only a verified merge, with one bounded argv-only lookup', async () => {
    await publish();
    expect(await check()).toMatchObject({ status: 'ready', evidence: { jobState: 'published', sources: { publish: 'healthy' }, publicationUrl: url,
      pr: { number: 123, headRefOid: expectedHead, mergeCommit: mergeOid, mergedAt: merged.mergedAt } } });
    expect(runner).toHaveBeenCalledExactlyOnceWith('gh', ['pr', 'view', '123', '--repo', repo, '--json', 'number,url,state,headRefOid,mergeCommit,mergedAt'],
      { cwd: process.cwd(), timeoutMs: 15000, maxStdoutBytes: 65536 });
  });

  it.each([
    ['fork URL', 'https://github.com/fork-owner/project/pull/123'],
    ['wrong repo', 'https://github.com/example/other/pull/123'],
    ['host spoof', 'https://github.com.example.invalid/example/project/pull/123'],
    ['suffix', `${url}/files`], ['query', `${url}?x=1`], ['nonnumeric', 'https://github.com/example/project/pull/abc'],
  ])('refuses %s publication without a GitHub lookup', async (_name, pr) => {
    await publish(pr);
    expect((await check()).status).toBe('unavailable');
    expect(runner).not.toHaveBeenCalled();
  });

  it('accepts a fork contribution published at the base repository PR URL', async () => {
    await publish();
    await writeFile(join(runsDir, `${job}.base`), `aaaa codex-bridge/fork /fake/fork-worktree\n`);
    expect((await check()).status).toBe('ready');
  });

  it.each([
    ['open', { ...merged, state: 'OPEN', mergeCommit: null, mergedAt: null }, 'pending'],
    ['closed unmerged', { ...merged, state: 'CLOSED', mergeCommit: null, mergedAt: null }, 'stale'],
    ['moved head', { ...merged, headRefOid: 'c'.repeat(40) }, 'stale'],
    ['wrong number', { ...merged, number: 124 }, 'unavailable'],
    ['wrong response repo', { ...merged, url: 'https://github.com/fork/project/pull/123' }, 'unavailable'],
    ['missing merge commit', { ...merged, mergeCommit: null }, 'unavailable'],
    ['invalid merge date', { ...merged, mergedAt: '2026-02-30T12:00:00Z' }, 'unavailable'],
    ['missing field', { ...merged, headRefOid: undefined }, 'unavailable'],
    ['contradictory closed', { ...merged, state: 'CLOSED' }, 'unavailable'],
  ])('classifies %s', async (_name, data, status) => {
    await publish(); response(data);
    expect((await check()).status).toBe(status);
  });

  it('fails closed on malformed, truncated, timed-out and failed GitHub responses', async () => {
    await publish();
    for (const fields of [
      { stdout: '{"state":' }, { truncated: true }, { timedOut: true }, { missing: true }, { code: 1 },
    ]) {
      runner.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(merged), stderr: 'private failure', timedOut: false, truncated: false, missing: false, ...fields });
      const result = await check();
      expect(result.status).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('private failure');
    }
  });

  it('fails closed on absent and degraded publication evidence', async () => {
    expect((await check()).status).toBe('pending');
    await symlink(join(runsDir, 'missing'), join(runsDir, `${job}.publish`));
    expect(await check()).toMatchObject({ status: 'unavailable', evidence: { sources: { publish: 'degraded' } } });
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not release an old publication while a newer attempt is running', async () => {
    await publish();
    const old = new Date('2026-01-01T00:00:00Z');
    await utimes(join(runsDir, `${job}.publish`), old, old);
    await writeFile(join(runsDir, `${job}.launch`), `launched ${job} fake pid 42 base abc1234\n`);
    await writeFile(join(runsDir, `${job}.log`), 'new attempt\n');
    expect(await check()).toMatchObject({ status: 'pending', evidence: { jobState: 'running' } });
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects invalid inputs before reading or calling GitHub', async () => {
    await publish();
    for (const invalid of [{ ...input, expectedHead: `${expectedHead}\n` }, { ...input, repo: `${repo}\n` }, { ...input, job: '../bad' }]) {
      expect((await fleetPrerequisite(invalid, { runner, detailOptions: { runsDir } })).status).toBe('unavailable');
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('prints JSON with nonzero exit unless ready and explains publication in help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['--job', job, '--repo', repo, '--expected-head', expectedHead, '--json'];
    expect(await main(args, { runner, detailOptions: { runsDir } })).toBe(1);
    expect(JSON.parse(String(log.mock.lastCall?.[0])).status).toBe('pending');
    await publish();
    expect(await main(args, { runner, detailOptions: { runsDir } })).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0])).status).toBe('ready');
    expect(await main(['--help'])).toBe(0);
    expect(String(log.mock.lastCall?.[0])).toMatch(/publication is a handoff, not proof of a merge/i);
  });
});
