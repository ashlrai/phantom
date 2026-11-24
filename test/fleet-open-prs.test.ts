import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openPrCount, refreshOpenPrs } from '../src/core/fleet/open-prs.js';
import * as git from '../src/core/verse/git-ops.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';
import { readLeaderBrief } from '../src/core/fleet/leader-brief.js';
import { cmdFleetOpenPrs } from '../src/cli/fleet-open-prs.js';
const repo = 'ashlrai/phantom', now = Date.parse('2026-11-22T12:00:00Z');
let root: string;
const api = (stdout: string, code = 0): GitRunner => vi.fn(async () => ({ stdout, stderr: 'withheld upstream error', code, timedOut: false, truncated: false, missing: false }));
const brief = () => readLeaderBrief({ repoRoot: root, now: () => now, readers: { installed: () => null, latest: () => null, needsMason: () => null, goals: () => null, lanes: () => null } });
const success = () => api(JSON.stringify([{ number: 7, title: 'bridge: RQ-SNAPSHOT', headRefName: 'bridge/RQ-SNAPSHOT', createdAt: '2026-11-22T10:00:00Z', mergeStateStatus: 'DIRTY' }, { number: 8 }]));
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'open-prs-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('reads GitHub only, writes private typed rows and preserves missing fields as unknown', async () => {
  const run = success(), s = await refreshOpenPrs(root, repo, now, run);
  expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['list', '--state', 'open', '--repo', repo]), expect.objectContaining({ timeoutMs: 30_000 }));
  expect(s).toMatchObject({ state: 'ready', total: 2, items: [{ repo, number: 7, ageHours: 2, jobId: 'RQ-SNAPSHOT', mergeStateStatus: 'DIRTY' }, { repo, number: 8, ageHours: null, jobId: null, mergeStateStatus: 'UNKNOWN' }] });
  expect(JSON.parse(await readFile(join(root, 'fleet/open-prs.json'), 'utf8'))).toEqual(s);
  expect((await stat(join(root, 'fleet/open-prs.json'))).mode & 0o777).toBe(0o600);
  vi.stubEnv('ASHLR_RUNS_DIR', root); expect((await brief()).openPrs).toBe(2);
  expect(openPrCount(s, now)).toBe(2); expect(openPrCount(s, now + 300_001)).toBeNull(); expect(openPrCount(s, now - 1)).toBeNull();
});
it.each(['failure', 'throw', 'malformed', 'invalid-row', 'limit', 'timeout', 'truncated'])('keeps API %s unknown without a cache', async mode => {
  const run: GitRunner = mode === 'throw' ? async () => { throw new Error('withheld'); }
    : mode === 'timeout' || mode === 'truncated' ? async () => ({ stdout: '[]', stderr: '', code: 0, timedOut: mode === 'timeout', truncated: mode === 'truncated', missing: false })
    : api(mode === 'malformed' ? '{' : mode === 'invalid-row' ? '[{}]' : mode === 'limit' ? JSON.stringify(Array(1000).fill({ number: 1 })) : '[]', mode === 'failure' ? 1 : 0);
  const s = await refreshOpenPrs(root, repo, now, run);
  expect(s).toMatchObject({ state: 'unavailable', total: null, items: null }); expect(openPrCount(s, now)).toBeNull();
  expect(JSON.stringify(s)).not.toContain('withheld');
});
it('retains last-known rows across failures, with unknown current count; expires and scopes the fallback', async () => {
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  const good = await refreshOpenPrs(root, repo, now, success());
  for (const offset of [1, 2]) {
    const s = await refreshOpenPrs(root, repo, now + offset, api('', 1));
    expect(s).toMatchObject({ state: 'fallback', total: null, observedAt: good.observedAt, items: good.items }); expect(openPrCount(s, now)).toBeNull();
  }
  expect((await brief()).openPrs).toBeNull();
  expect((await refreshOpenPrs(root, repo, now + 300_001, api('', 1))).state).toBe('unavailable');
  await refreshOpenPrs(root, repo, now, success());
  expect((await refreshOpenPrs(root, 'ashlrai/locus', now, api('', 1))).items).toBeNull();
  expect((await refreshOpenPrs(root, repo, now, api('[]'))).total).toBe(0);
});
it('rejects invalid CLI input without accessing GitHub', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetOpenPrs(['--repo', '--json'])).toBe(2);
});
it.each([0, 1])('prints the saved typed snapshot and returns GitHub status %s', async code => {
  vi.spyOn(git, 'defaultGitRunner').mockImplementation(api('[]', code));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetOpenPrs(['--repo', repo, '--root', root, '--json'])).toBe(code);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: 'fleet.open-prs.v1', repo, total: code ? null : 0 });
  expect(await cmdFleetOpenPrs(['--repo', repo, '--root', root])).toBe(code);
  expect(String(log.mock.calls[1]![0])).toContain(code ? 'Open PRs: unknown' : 'Open PRs: 0 (fresh)');
});
