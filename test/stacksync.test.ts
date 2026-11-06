import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueStore } from '../src/core/queue/store.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup(flag?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'stacksync-'));
  directories.push(directory);
  const path = join(directory, 'fleet.jsonl');
  vi.stubEnv('PHANTOM_STACKSYNC', flag);
  vi.stubEnv('PHANTOM_STACKSYNC_FILE', path);
  const store = new QueueStore(directory);
  for (const id of ['RQ-A', 'RQ-B']) {
    await store.add({ id, status: 'READY', priority: 'P1', pool: 'codex-personal', tier: 'work',
      repo: 'phantom', deps: [], scope: 'private task content', acceptance: '', claims: [] });
    await store.claim(id, 'worker');
  }
  return { store, path };
}
it.each([undefined, 'off', 'invalid'])('makes zero network calls or exports with flag %s', async flag => {
  const { store, path } = await setup(flag);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unreachable'));
  expect((await store.finish('RQ-A', 'worker')).status).toBe('DONE');
  expect(network).not.toHaveBeenCalled();
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('writes one JSONL row per finished job, excluding open PRs and duplicate completions', async () => {
  const { store, path } = await setup('on');
  const prUrl = 'https://github.com/ashlrai/phantom/pull/123';
  await store.finish('RQ-A', 'worker', { prUrl });
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  const done = await store.finish('RQ-A', 'worker');
  await store.finish('RQ-B', 'worker', { reason: 'blocked' });
  await expect(store.finish('RQ-A', 'worker')).rejects.toThrow('active claim');
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toEqual([
    { jobId: 'RQ-A', status: 'DONE', durationMs: Date.parse(done.claims[0].finishedAt!) - Date.parse(done.claims[0].claimedAt), mergedPr: prUrl },
    { jobId: 'RQ-B', status: 'BLOCKED', durationMs: expect.any(Number), mergedPr: null },
  ]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
it('preserves completion when the optional sink is unavailable or a symlink', async () => {
  const { store, path } = await setup('on');
  vi.stubEnv('PHANTOM_STACKSYNC_FILE', join(path, 'missing', 'fleet.jsonl'));
  expect((await store.finish('RQ-A', 'worker')).status).toBe('DONE');
  const target = path + '.target';
  await writeFile(target, 'unchanged');
  await symlink(target, path);
  vi.stubEnv('PHANTOM_STACKSYNC_FILE', path);
  expect((await store.finish('RQ-B', 'worker')).status).toBe('DONE');
  expect(await readFile(target, 'utf8')).toBe('unchanged');
});
