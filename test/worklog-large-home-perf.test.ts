// Large fleet home: the Feed and Fleet reads stay incremental. A desktop sidecar
// on a 600-worktree home re-parsed the whole jobs ledger on every /api/feed poll.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFeed } from '../src/core/feed.js';
import { readLedger, readWorklog } from '../src/core/fleet/worklog.js';

const WORKTREES = 600;
const LINES = 100_000;
const NOW = Date.parse('2026-11-26T00:00:00Z');
let root = '';
let runsDir = '';

const line = (i: number, at: number) => JSON.stringify({ event: ['launch', 'finish', 'merged', 'publish'][i % 4], job: `RQ-PERF-${i % 2000}`,
  lane: 'codex', model: 'gpt-x', ts: new Date(at).toISOString(), repo: 'phantom', exit_code: 0 }) + '\n';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'worklog-perf-'));
  runsDir = join(root, 'runs');
  for (const d of ['metrics', 'queue/run', 'logs']) mkdirSync(join(runsDir, d), { recursive: true });
  for (let i = 0; i < WORKTREES; i++) {
    mkdirSync(join(root, 'wt', `RQ-PERF-${i}`), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'run', `RQ-PERF-${i}.line`), `RQ-PERF-${i}\tphantom\tcodex\twork\t/p.md\n`);
  }
  const chunks: string[] = [];
  // A week of history, all inside the Feed's 7-day window: the worst case for a window read.
  for (let i = 0; i < LINES; i++) chunks.push(line(i, NOW - (LINES - i) * 6_000));
  writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), chunks.join(''));
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const timed = async (fn: () => Promise<unknown>): Promise<number> => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

it('parses the jobs ledger once and then only what was appended', async () => {
  const ledgerPath = join(runsDir, 'metrics', 'jobs.jsonl');
  const first = await readLedger(ledgerPath);
  expect(first.rows).toHaveLength(LINES);
  expect(await readLedger(ledgerPath)).toBe(first);
  appendFileSync(ledgerPath, line(LINES, NOW - 1_000) + '{"partial":');
  const grown = await readLedger(ledgerPath);
  expect(grown.rows).toHaveLength(LINES + 1);
  appendFileSync(ledgerPath, '1}\n');
  expect((await readLedger(ledgerPath)).rows).toHaveLength(LINES + 2);
  // Truncation (rotation) starts over.
  writeFileSync(ledgerPath, line(0, NOW - 1_000));
  expect((await readLedger(ledgerPath)).rows).toHaveLength(1);
}, 60_000);

it('answers repeat Feed reads on a 600-worktree, 100k-line home within budget', async () => {
  const chunks: string[] = [];
  for (let i = 0; i < LINES; i++) chunks.push(line(i, NOW - (LINES - i) * 6_000));
  writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), chunks.join(''));
  const readers = { worklog: (hours: number, now: number) => readWorklog(hours, { runsDir, now }), proposalMerges: async () => [], outbox: async () => null, guardian: async () => null };
  await readFeed({ limit: 50 }, readers, NOW);
  const cpuBefore = process.cpuUsage();
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) warm.push(await timed(() => readFeed({ limit: 50 }, readers, NOW)));
  const cpu = process.cpuUsage(cpuBefore);
  warm.sort((a, b) => a - b);
  // Budgets carry headroom for slow CI runners; an unchanged ledger used to cost ~1 s and 60 MB per read.
  expect(warm[2]).toBeLessThan(1_500);
  expect((cpu.user + cpu.system) / 1000).toBeLessThan(7_500);
}, 120_000);
