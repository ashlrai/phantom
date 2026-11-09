import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTmpHome } from './helpers/leader-310b-fakes.js';
import { leaderRoot } from '../src/core/vision/leader-memo.js';
import { leaderThreadPath, syncLeaderReplies } from '../src/core/vision/leader-thread.js';
import { runLeaderCli } from '../src/cli/leader.js';
const home = useTmpHome();
let plan: string;
beforeEach(() => {
  home.setup();
  vi.stubEnv('ASHLR_RUNS_DIR', join(leaderRoot(), 'runs'));
  const dir = join(leaderRoot(), 'runs/leader');
  mkdirSync(dir, { recursive: true });
  plan = join(dir, 'PLAN-LOG.md');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); home.teardown(); });
it('posts two dated blocks once through CLI and typed API without modifying the plan', async () => {
  const fixture = [1, 2].map(i => `## 2026-11-09 0${i}:00 ET\n### Reply for Mason\nYour reply is here.\nAnother paragraph.\n### Planning\nDo not relay this.`).join('\n');
  writeFileSync(plan, fixture); chmodSync(plan, 0o444);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await runLeaderCli(['replies', 'sync', '--json'])).toBe(0);
  const first = JSON.parse(String(log.mock.calls.at(-1)![0]));
  expect(first.posted).toHaveLength(1);
  expect(first.skipped).toEqual([]);
  const second = await syncLeaderReplies();
  expect(second.posted).toEqual([]);
  expect(second.skipped).toEqual(first.posted);
  const messages = readFileSync(leaderThreadPath(), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  expect(messages).toHaveLength(1);
  expect(messages.every(m => m.text === 'Your reply is here.\nAnother paragraph.' && m.delivery.telegram === 'pending')).toBe(true);
  expect(readFileSync(plan, 'utf8')).toBe(fixture);
});
it('reports missing and unknown sources and excludes undated text', async () => {
  expect((await syncLeaderReplies()).sourceState).toBe('missing');
  mkdirSync(plan);
  expect((await syncLeaderReplies()).sourceState).toBe('unknown');
});
it('reads only the bounded tail and never relays an orphan reply', async () => {
  writeFileSync(plan, `## 2026-11-08 01:00 ET\n### Reply for Mason\n${'x'.repeat(270000)}\n### Reply for Mason\nOrphan\n## 2026-11-09 02:00 ET\nReply for Mason: Latest`);
  expect((await syncLeaderReplies()).posted).toHaveLength(1);
  expect(readFileSync(leaderThreadPath(), 'utf8')).not.toContain('Orphan');
});
it('preserves uncertain receipts and refuses malformed receipt state', async () => {
  writeFileSync(plan, '## 2026-11-09 01:00 ET\nReply for Mason: Hello');
  const first = await syncLeaderReplies();
  const path = join(leaderRoot(), 'thread-index.json');
  const index = JSON.parse(readFileSync(path, 'utf8'));
  index.planReplies[first.posted[0]!] = 'pending';
  writeFileSync(path, JSON.stringify(index));
  expect((await syncLeaderReplies()).unknown).toEqual(first.posted);
  index.planReplies = { broken: 'posted' };
  writeFileSync(path, JSON.stringify(index));
  await expect(syncLeaderReplies()).rejects.toThrow('malformed');
});
