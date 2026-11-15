// Recut of #4386 (RQ-PHX-EMPTYWHYPANEL16): the Growth "Why jobs came back
// empty" panel's report now carries the `fleet empty-why` log-tail reasons.
// The API report and the CLI share one classifier, so for the same ledger and
// logs they must agree, and the reasons ride alongside master's topCauses.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { summarizeEmptyWhy } from '../src/cli/fleet-empty-why.js';
import { emptyJobs } from '../src/core/fleet/empty-job-ledger.js';
import { readEmptyJobs } from '../src/core/fleet/empty-jobs.js';

let dir: string; let runs: string; let wt: string;
const now = Date.parse('2026-11-09T13:00:00Z');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recut-b61-'));
  runs = join(dir, 'runs'); wt = join(dir, 'wt');
  await mkdir(join(runs, 'metrics'), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it('tags each empty job the same way the CLI does, next to the note-based causes', async () => {
  const rows = [['A', 'claude'], ['B', 'devin'], ['C', 'claude'], ['D', 'devin']] as const;
  const ledger = rows.map(([job, lane]) => JSON.stringify({ event: 'outcome', empty: true, job, lane, ts: '2026-11-09T12:00:00Z' })).join('\n');
  await writeFile(join(runs, 'metrics/jobs.jsonl'), ledger);
  const logs: Record<string, string> = { A: 'You hit your usage limit', B: 'process exited with code 130', C: 'ESLint crashed in lib/cli' };
  for (const [id, text] of Object.entries(logs)) await writeFile(join(runs, `${id}.log`), text);
  await mkdir(join(wt, 'A'), { recursive: true });
  await writeFile(join(wt, 'A', 'BRIDGE_NOTES.md'), 'Already implemented in an existing PR.');

  const report = await readEmptyJobs(24, runs, wt, now);
  const cli = summarizeEmptyWhy(emptyJobs(ledger, now, 24), new Map(rows.map(([id]) => [id, logs[id] ?? null])), 24);

  expect(report?.reasons?.by_reason).toEqual(cli.by_reason);
  expect(report?.reasons?.by_reason).toEqual({ limit: 1, interrupted: 1, 'lint-env': 1, blocked: 0, other: 1 });
  expect(report?.reasons?.recent).toEqual([
    { id: 'D', lane: 'devin', reason: 'other' },
    { id: 'C', lane: 'claude', reason: 'lint-env' },
    { id: 'B', lane: 'devin', reason: 'interrupted' },
    { id: 'A', lane: 'claude', reason: 'limit' },
  ]);
  // The notes-first classes and topCauses are unchanged by the new reasons.
  expect(report?.jobs.find(job => job.id === 'A')?.class).toBe('already-done');
  expect(report?.topCauses.map(cause => cause.class)).toContain('already-done');
});
