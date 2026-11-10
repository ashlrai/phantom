import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'leader-relay-restart-'));
  homes.push(home);
  const runs = join(home, 'runs');
  mkdirSync(join(runs, 'leader'), { recursive: true });
  const plan = join(runs, 'leader', 'PLAN-LOG.md');
  const bytes = Buffer.from('## 2026-11-09 01:00 ET\nReply for Mason: First synthetic reply\n## 2026-11-09 02:00 ET\nReply for Mason: Second synthetic reply\n');
  writeFileSync(plan, bytes);
  chmodSync(plan, 0o444);
  const root = join(home, '.ashlr', 'vision', 'leader');
  const run = (expectedStatus = 0) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'leader', 'replies', 'sync', '--json'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_RUNS_DIR: runs }, encoding: 'utf8', timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(expectedStatus);
    return JSON.parse(child.stdout);
  };
  const records = () => readFileSync(join(root, 'thread.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { plan, bytes, root, run, records };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it('persists reply receipts across CLI processes without changing the source', () => {
  const f = fixture();
  const first = f.run();
  expect(first.sourceState).toBe('healthy');
  expect(first.posted).toHaveLength(2);
  expect(first.skipped).toEqual([]);
  expect(first.unknown).toEqual([]);
  const second = f.run();
  expect(second).toEqual({ sourceState: 'healthy', posted: [], skipped: first.posted, unknown: [] });
  const messages = f.records();
  expect(messages.map(m => m.text)).toEqual(['First synthetic reply', 'Second synthetic reply']);
  expect(messages.every(m => m.kind === 'answer' && m.delivery.telegram === 'pending' && !m.delivery.sentAt)).toBe(true);
  expect(readFileSync(f.plan)).toEqual(f.bytes);
}, 60_000);

it('reports a pending receipt as uncertain after restart without replay', () => {
  const f = fixture();
  const first = f.run();
  const before = readFileSync(join(f.root, 'thread.jsonl'));
  const indexPath = join(f.root, 'thread-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.planReplies[first.posted[0]] = 'pending';
  writeFileSync(indexPath, JSON.stringify(index));
  const second = f.run(1);
  expect(second).toEqual({ sourceState: 'healthy', posted: [], skipped: first.posted, unknown: [first.posted[0]] });
  expect(readFileSync(join(f.root, 'thread.jsonl'))).toEqual(before);
  expect(f.records().every(m => m.delivery.telegram === 'pending' && !m.delivery.sentAt)).toBe(true);
  expect(readFileSync(f.plan)).toEqual(f.bytes);
}, 60_000);
