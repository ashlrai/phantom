import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { QueueStore } from '../src/core/queue/store.js';
import type { QueueJob } from '../src/core/queue/schema.js';
import { cmdQueue } from '../src/cli/queue.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'replay-')); directories.push(dir);
  const store = new QueueStore(dir);
  const job: QueueJob = { id: 'ROOT', status: 'BLOCKED', priority: 'P1', pool: 'test', tier: 'work', repo: 'phantom', scope: 'repair', acceptance: '', deps: [], claims: [{ owner: 'test', claimedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-02T00:00:00Z' }] };
  await store.add(job); return { store, job, dir };
}
it('persists lineage and serializes concurrent and repeated replay requests', async () => {
  const { store, dir } = await setup();
  const results = await Promise.all([store.replay({}), new QueueStore(dir).replay({})]);
  expect(results.flat()).toHaveLength(1);
  const [run] = results.flat(); expect(run.replayOf).toBe('ROOT');
  expect(await new QueueStore(dir).replay({})).toEqual([]);
  expect((await store.read()).jobs).toHaveLength(2);
});
it('replays transitive dependents in dependency order and gates claims', async () => {
  const { store, job } = await setup();
  await store.add({ ...job, id: 'CHILD', status: 'DONE', deps: ['ROOT'] });
  await store.add({ ...job, id: 'LEAF', status: 'DONE', deps: ['CHILD'] });
  const runs = await store.replay({ mode: 'replay_failed_and_dependents' });
  expect(runs.map(run => run.replayOf)).toEqual(['ROOT', 'CHILD', 'LEAF']);
  expect(runs[1].deps).toEqual([runs[0].id]);
  await expect(store.claim(runs[1].id, 'worker')).rejects.toThrow('Dependencies not DONE');
  await store.claim(runs[0].id, 'worker'); await store.finish(runs[0].id, 'worker');
  await expect(store.claim(runs[1].id, 'worker')).resolves.toMatchObject({ status: 'CLAIMED' });
});
it('CLI dry-run filters without modifying the durable snapshot', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { store, dir } = await setup(); const before = await readFile(store.path, 'utf8');
  expect(await cmdQueue(['replay', '--failed', '--since', '2026-11-02T00:00:00Z', '--query', 'repair', '--dry-run', '--dir', dir, '--json'])).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual([expect.objectContaining({ replayOf: 'ROOT', status: 'READY' })]);
  output.mockRestore();
  expect(await readFile(store.path, 'utf8')).toBe(before);
  expect(await store.replay({ since: '2026-11-03T00:00:00Z' })).toEqual([]);
  expect(await store.replay({ query: 'absent' })).toEqual([]);
  await expect(store.replay({ since: 'invalid' })).rejects.toThrow('Invalid --since');
});

it('refuses active dependents without partial writes', async () => {
  const { store, job } = await setup();
  await store.add({ ...job, id: 'CHILD', status: 'READY', deps: ['ROOT'] });
  await expect(store.replay({ mode: 'replay_failed_and_dependents' })).rejects.toThrow('Active dependent');
  expect((await store.read()).jobs).toHaveLength(2);
});
