import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeNodeCapacity, type NodeSnapshot } from '../src/core/drive/nodes/capacity-model.js';
import { foldRouteLaneOutcomes, readRouteLaneOutcomes } from '../src/core/drive/nodes/route-outcomes.js';
import type { RouterOutcome } from '../src/core/router/outcomes.js';

const GIB = 1024 ** 3, MIB = 1024 ** 2;

const outcome = (job: string, lane: string | null, merged: boolean | null, reverted: boolean | null = null): RouterOutcome => ({
  schema: 'router.outcome.v1', job_id: job, lane, model: null, tier: null, work_class: null,
  lane_hint: null, lane_override: null,
  merged, reverted, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null,
  tokens_total: null, acus: null, tokens_in: null, tokens_out: null,
  tokens_cache_read: null, tokens_cache_write: null,
  usage_source: null, usage_missing: null,
  ttm_s: null, queue_wait_s: null, ci_wall_s: null, empty: null, diff_files: null, diff_lines: null,
  exit_code: null, failure_class: null, empty_class: null,
  task_outcome: null, lane_hint_blocked_by: null, passk: null,
});

describe('foldRouteLaneOutcomes', () => {
  it('counts only known merge verdicts as attempts, per lane, keys sorted', () => {
    const folded = foldRouteLaneOutcomes([
      outcome('a', 'grok', true), outcome('b', 'grok', true), outcome('c', 'grok', false),
      outcome('d', 'codex', false), outcome('e', 'codex', null), outcome('f', null, true),
      outcome('g', 'claude', null),
    ]);
    expect(folded).toEqual({ codex: { attempts: 1, merged: 0 }, grok: { attempts: 3, merged: 2 } });
    expect(Object.keys(folded)).toEqual(['codex', 'grok']);
  });

  it('counts a reverted merge as an attempt but never as a held merge', () => {
    const folded = foldRouteLaneOutcomes([
      outcome('a', 'grok', true, true), outcome('b', 'grok', true), outcome('c', 'grok', true, false),
      outcome('d', 'grok', false, true), outcome('e', 'codex', true, true),
    ]);
    expect(folded).toEqual({ codex: { attempts: 1, merged: 0 }, grok: { attempts: 4, merged: 2 } });
  });

  it('returns an empty map for no usable outcomes', () => {
    expect(foldRouteLaneOutcomes([])).toEqual({});
    expect(foldRouteLaneOutcomes([outcome('x', null, true), outcome('y', 'grok', null)])).toEqual({});
  });
});

describe('readRouteLaneOutcomes', () => {
  const ledger = (dir: string, rows: unknown[]) => {
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return dir;
  };

  it('folds metrics/jobs.jsonl into per-lane tallies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-out-'));
    ledger(dir, [
      { job: 'j1', lane: 'grok', ts: '2026-11-16T05:00:00Z', state: 'MERGED' },
      { job: 'j2', lane: 'grok', ts: '2026-11-16T05:01:00Z', state: 'CLOSED' },
      { job: 'j3', lane: 'grok', ts: '2026-11-16T05:02:00Z', event: 'launch' },
      { job: 'j4', lane: 'codex', ts: '2026-11-16T05:03:00Z', state: 'MERGED' },
    ]);
    const read = await readRouteLaneOutcomes({ runsDir: dir });
    expect(read.state).toBe('read');
    expect(read.schema).toBe('phantom.node-route-outcomes.v1');
    expect(read.outcomes).toEqual({ codex: { attempts: 1, merged: 1 }, grok: { attempts: 2, merged: 1 } });
  });

  it('does not count a ledger-recorded revert as a held merge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-out-'));
    ledger(dir, [
      { job: 'j1', lane: 'grok', ts: '2026-11-16T05:00:00Z', state: 'MERGED' },
      { job: 'j1', lane: 'grok', ts: '2026-11-16T06:00:00Z', event: 'reverted' },
      { job: 'j2', lane: 'grok', ts: '2026-11-16T05:01:00Z', state: 'MERGED' },
    ]);
    const read = await readRouteLaneOutcomes({ runsDir: dir });
    expect(read.state).toBe('read');
    expect(read.outcomes).toEqual({ grok: { attempts: 2, merged: 1 } });
  });

  it('reports a missing ledger as missing with empty tallies, and a non-file as not-file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-out-'));
    const missing = await readRouteLaneOutcomes({ runsDir: dir });
    expect(missing.state).toBe('missing');
    expect(missing.outcomes).toEqual({});
    mkdirSync(join(dir, 'metrics'));
    mkdirSync(join(dir, 'metrics', 'jobs.jsonl'));
    const notFile = await readRouteLaneOutcomes({ runsDir: dir });
    expect(notFile.state).toBe('not-file');
    expect(notFile.outcomes).toEqual({});
  });
});

describe('phm node route --outcomes-ledger', () => {
  const snap = (): NodeSnapshot => ({
    node: 'mbp', measuredAtMs: Date.now(), platform: 'darwin',
    cpu: { cores: 18, load: [10, 10, 10], busyPercent: 50 },
    mem: { totalBytes: 128 * GIB, freeBytes: 40 * GIB, freePercent: 43, pressureLevel: 1 },
    swap: { usedBytes: 7 * GIB, totalBytes: 8 * GIB, swapoutsTotal: 1_000 },
    processSource: 'ps',
    sessions: [{ harness: 'codex', rootPid: 10, processes: 5, memBytes: 400 * MIB, cpuPercent: 30 }],
  });

  const setup = (ledgerRows: unknown[] | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'node-route-ledger-'));
    const file = (name: string, value: unknown) => { writeFileSync(join(dir, name), JSON.stringify(value)); return join(dir, name); };
    mkdirSync(join(dir, 'runs', 'metrics'), { recursive: true });
    if (ledgerRows !== null) {
      writeFileSync(join(dir, 'runs', 'metrics', 'jobs.jsonl'), ledgerRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    const cap = file('cap.json', computeNodeCapacity(snap()));
    const costs = file('costs.json', [
      { provider: 'good', model: 'm-good', harness: 'codex', tokensPerJob: 1e6, minutesPerJob: 30 },
      { provider: 'bad', model: 'm-bad', harness: 'codex', tokensPerJob: 1e6, minutesPerJob: 30 },
    ]);
    const jobs = file('jobs.json', [{ id: 'j1' }]);
    return { dir, cap, costs, jobs, runsDir: join(dir, 'runs') };
  };

  const capture = async (fn: () => Promise<number>) => {
    const lines: string[] = [];
    const log = console.log, error = console.error;
    console.log = (line: string) => { lines.push(line); };
    console.error = (line: string) => { lines.push(line); };
    try { return { code: await fn(), lines }; } finally { console.log = log; console.error = error; }
  };

  it('routes by ledger merge evidence and reports the ledger state', async () => {
    const { cmdNodeRoute } = await import('../src/cli/node-capacity.js');
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({ job: `g${i}`, lane: 'good', ts: '2026-11-16T05:00:00Z', state: 'MERGED' })),
      ...Array.from({ length: 4 }, (_, i) => ({ job: `b${i}`, lane: 'bad', ts: '2026-11-16T05:00:00Z', state: 'CLOSED' })),
    ];
    const { cap, costs, jobs, runsDir } = setup(rows);
    const { code, lines } = await capture(() => cmdNodeRoute(
      ['--capacity', cap, '--costs', costs, '--jobs', jobs, '--outcomes-ledger', '--runs-dir', runsDir, '--json']));
    expect(code).toBe(0);
    const out = JSON.parse(lines[0]!);
    expect(out.schema).toBe('phantom.node-route.v1');
    expect(out.plan[0]).toMatchObject({ jobId: 'j1', provider: 'good' });
    expect(out.outcomes_ledger).toMatchObject({ state: 'read', truncated: false, providers: 2 });
  });

  it('lets an explicit --outcomes file win per provider over the ledger', async () => {
    const { cmdNodeRoute } = await import('../src/cli/node-capacity.js');
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({ job: `g${i}`, lane: 'good', ts: '2026-11-16T05:00:00Z', state: 'MERGED' })),
      ...Array.from({ length: 4 }, (_, i) => ({ job: `b${i}`, lane: 'bad', ts: '2026-11-16T05:00:00Z', state: 'CLOSED' })),
    ];
    const { dir, cap, costs, jobs, runsDir } = setup(rows);
    const outcomesFile = join(dir, 'outcomes.json');
    writeFileSync(outcomesFile, JSON.stringify({ good: { attempts: 10, merged: 0 } }));
    const { code, lines } = await capture(() => cmdNodeRoute(
      ['--capacity', cap, '--costs', costs, '--jobs', jobs, '--outcomes', outcomesFile, '--outcomes-ledger', '--runs-dir', runsDir, '--json']));
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!).plan[0]).toMatchObject({ provider: 'bad' });
  });

  it('refuses an unreadable ledger and rejects --runs-dir without --outcomes-ledger', async () => {
    const { cmdNodeRoute } = await import('../src/cli/node-capacity.js');
    const { cap, costs, jobs, runsDir } = setup(null);
    mkdirSync(join(runsDir, 'metrics', 'jobs.jsonl'));
    const bad = await capture(() => cmdNodeRoute(
      ['--capacity', cap, '--costs', costs, '--jobs', jobs, '--outcomes-ledger', '--runs-dir', runsDir, '--json']));
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.lines[0]!).error).toMatch(/state=not-file/);
    const orphan = await capture(() => cmdNodeRoute(
      ['--capacity', cap, '--costs', costs, '--jobs', jobs, '--runs-dir', runsDir, '--json']));
    expect(orphan.code).toBe(2);
    expect(JSON.parse(orphan.lines[0]!).error).toMatch(/--outcomes-ledger/);
  });
});
