/**
 * phm eval dataset — fold live fleet ledgers into a router-eval.v1 dataset.
 *
 * Covers the RouterOutcome -> dataset-line mapping (merged/closed/failed/
 * held/pending honesty rules, arm attribution, unknown-stays-absent) and
 * the CLI seam (deps-injected reads/writes). The end-to-end case runs the
 * real readRouterOutcomes fold over fixture ledgers and round-trips the
 * emitted text through parseRouterEvalDataset — the producer's output must
 * always be a dataset the harness accepts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cmdEvalDataset } from '../src/cli/eval-dataset.js';
import {
  foldRouterEvalDataset,
  routerEvalDatasetText,
  routerOutcomeToDatasetJob,
} from '../src/core/eval/router-dataset.js';
import { parseRouterEvalDataset } from '../src/core/eval/router-eval.js';
import { readRouterOutcomes, type RouterOutcome, type RouterOutcomeRead } from '../src/core/router/outcomes.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function outcome(over: Partial<RouterOutcome> = {}): RouterOutcome {
  return {
    schema: 'router.outcome.v1', job_id: 'RQ-X', lane: 'alpha', model: null, tier: 'work', work_class: null, repo: null,
    lane_hint: null, lane_override: null,
    merged: null, reverted: null, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null,
    tokens_total: null, acus: null, tokens_in: null, tokens_out: null,
    tokens_cache_read: null, tokens_cache_write: null,
    usage_source: null, usage_missing: null,
    ttm_s: null, queue_wait_s: null, ci_wall_s: null, publish_wait_s: null, empty: null, diff_files: null, diff_lines: null,
    exit_code: null, failure_class: null, empty_class: null, empty_tag: null,
    task_outcome: null, lane_hint_blocked_by: null,
    skipped: null, skip_reason: null, skip_code: null,
    deferred: null, defer_reason: null, defer_repeat_of: null,
    noop: null, noop_reason: null, noop_repeat_of: null,
    market_lane: null, market_preferred: null, market_override: null, market_reasons: null,
    market_rejected: null,
    handoff_trigger: null, handoff_lane: null, handoff_target: null,
    provider_wall_trigger: null, provider_wall_pattern: null, provider_wall_lane: null,
    pool_kind: null, pool_mem_free_pct: null, pool_swap_gb: null,
    node_outcome: null, node_id: null, node_pack: null,
    merge_queue: null, cross_review: null,
    launch_cost_status: null, launch_peak_processes: null, launch_mean_cpu_pct: null, launch_peak_cpu_pct: null,
    passk: null,
    ...over,
  };
}

function read(over: Partial<RouterOutcomeRead> = {}): RouterOutcomeRead {
  return {
    state: 'read', path: '/runs/metrics/jobs.jsonl', eval_state: 'missing',
    spend_state: 'missing', spend_truncated: false,
    market_state: 'missing', market_truncated: false,
    empty_tag_state: 'missing', empty_tag_truncated: false,
    merge_events_state: 'missing', merge_events_truncated: false,
    revert_ledger_state: 'missing',
    reward_state: 'missing', reward_truncated: false,
    launch_cost_state: 'missing', launch_cost_truncated: false,
    cross_review_state: 'missing', cross_review_truncated: false,
    outcomes: [], malformed_rows: 0, unattached_rows: 0, ambiguous_urls: 0, session_rows: 0, truncated: false,
    ...over,
  };
}

describe('routerOutcomeToDatasetJob', () => {
  it('maps a merged job with measured fields', () => {
    const line = routerOutcomeToDatasetJob(outcome({
      job_id: 'RQ-M', repo: 'phantom', tier: 'frontier',
      merged: true, cost_usd: 1.25, tokens_total: 4200, wall_s: 612.4,
      market_lane: 'alpha', market_preferred: 'beta',
    }))!;
    expect(line).toMatchObject({
      v: 1, id: 'RQ-M', outcome: 'merged', chosen: 'alpha',
      repo: 'phantom', tier: 'frontier', pool: 'beta',
      candidates: ['alpha'], costUsd: 1.25, tokens: 4200, wallTimeMs: 612400,
    });
  });

  it('maps explicit close evidence to closed', () => {
    expect(routerOutcomeToDatasetJob(outcome({ merged: false }))!.outcome).toBe('closed');
  });

  it.each([
    ['failure_class', { failure_class: 'rate_limit' }],
    ['nonzero exit_code', { exit_code: 1 }],
    ['failed task_outcome', { task_outcome: 'failed' }],
    ['empty finish', { empty: true, wall_s: 10 }],
    ['failed node verdict', { node_outcome: 'failed' }],
  ] as const)('maps dispatched failure evidence (%s) to failed', (_name, over) => {
    const line = routerOutcomeToDatasetJob(outcome({ ...over, wall_s: over.wall_s ?? 5 }))!;
    expect(line.outcome).toBe('failed');
    expect(line.chosen).toBe('alpha');
  });

  it('maps dispatched work with no terminal verdict to pending', () => {
    const line = routerOutcomeToDatasetJob(outcome({ wall_s: 300, exit_code: 0, empty: false }))!;
    expect(line.outcome).toBe('pending');
  });

  it('treats a launch-only job (model, no finish) as pending', () => {
    const line = routerOutcomeToDatasetJob(outcome({ model: 'm1' }))!;
    expect(line.outcome).toBe('pending');
  });

  it('maps a job with no dispatch evidence to held with chosen=null', () => {
    const line = routerOutcomeToDatasetJob(outcome({ lane: 'alpha', tier: 'work', repo: 'phantom', skipped: true }))!;
    expect(line.outcome).toBe('held');
    expect(line.chosen).toBeNull();
    expect(line.candidates).toEqual(['alpha']);
  });

  it('drops a dispatched verdict that names no arm', () => {
    expect(routerOutcomeToDatasetJob(outcome({ lane: null, market_lane: null, wall_s: 10 }))).toBeNull();
  });

  it('falls back to the market lane for chosen and dedupes candidates', () => {
    const line = routerOutcomeToDatasetJob(outcome({
      lane: null, market_lane: 'beta', merged: true,
    }))!;
    expect(line.chosen).toBe('beta');
    expect(line.candidates).toEqual(['beta']);
  });

  it('prefers market_preferred for pool and lane_hint as fallback', () => {
    expect(routerOutcomeToDatasetJob(outcome({ merged: true, market_preferred: 'beta', lane_hint: 'gamma' }))!.pool).toBe('beta');
    expect(routerOutcomeToDatasetJob(outcome({ merged: true, lane_hint: 'gamma' }))!.pool).toBe('gamma');
    expect(routerOutcomeToDatasetJob(outcome({ merged: true }))!.pool).toBeUndefined();
  });

  it('keeps unknown measures absent — never zero', () => {
    const line = routerOutcomeToDatasetJob(outcome({ merged: true }))!;
    expect('costUsd' in line).toBe(false);
    expect('tokens' in line).toBe(false);
    expect('wallTimeMs' in line).toBe(false);
  });

  it('drops measures outside the dataset shape rather than emit an unreadable line', () => {
    const line = routerOutcomeToDatasetJob(outcome({ merged: true, cost_usd: -1, tokens_total: 1.5, wall_s: Number.NaN }))!;
    expect('costUsd' in line).toBe(false);
    expect('tokens' in line).toBe(false);
    expect('wallTimeMs' in line).toBe(false);
  });
});

describe('foldRouterEvalDataset', () => {
  it('sorts lines by job_id and counts outcomes', () => {
    const computation = foldRouterEvalDataset([
      outcome({ job_id: 'RQ-B', merged: true }),
      outcome({ job_id: 'RQ-A', wall_s: 5 }),
      outcome({ job_id: 'RQ-C' }),
      outcome({ job_id: 'RQ-D', lane: null, market_lane: null, merged: true }),
    ]);
    expect(computation.jobs.map((j) => j.id)).toEqual(['RQ-A', 'RQ-B', 'RQ-C']);
    expect(computation.counts).toEqual({ merged: 1, closed: 0, failed: 0, held: 1, pending: 1 });
    expect(computation.unattributed).toBe(1);
  });

  it('emits text that parseRouterEvalDataset accepts', () => {
    const computation = foldRouterEvalDataset([
      outcome({ job_id: 'RQ-1', merged: true, cost_usd: 2, tokens_total: 100, wall_s: 60 }),
      outcome({ job_id: 'RQ-2' }),
      outcome({ job_id: 'RQ-3', lane: null, market_lane: null, wall_s: 9 }),
    ]);
    const ds = parseRouterEvalDataset(routerEvalDatasetText(computation, new Date('2026-11-02T00:00:00Z')));
    expect(ds.meta.id).toBe('fleet-router-eval-2026-11-02');
    expect(ds.jobs).toHaveLength(2);
    expect(ds.jobs.map((j) => j.outcome)).toEqual(['merged', 'held']);
  });
});

describe('cmdEvalDataset', () => {
  function harness(result: RouterOutcomeRead | Error) {
    const written: Record<string, string> = {};
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = (args: string[]) => cmdEvalDataset(args, {
      readOutcomes: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
      writeFile: (path, text) => { written[path] = text; },
      out: (t) => stdout.push(t),
      err: (t) => stderr.push(t),
      now: () => new Date('2026-11-02T00:00:00Z'),
    });
    return { run, written, stdout, stderr };
  }

  it('--out writes the dataset and prints a summary line', async () => {
    const { run, written, stdout } = harness(read({
      outcomes: [outcome({ job_id: 'RQ-1', merged: true }), outcome({ job_id: 'RQ-2' })],
    }));
    expect(await run(['--out', '/tmp/ds.jsonl'])).toBe(0);
    const ds = parseRouterEvalDataset(written['/tmp/ds.jsonl']!);
    expect(ds.jobs.map((j) => j.outcome)).toEqual(['merged', 'held']);
    expect(stdout.join('\n')).toContain('wrote 2 job lines');
  });

  it('prints the dataset to stdout without --out', async () => {
    const { run, stdout } = harness(read({ outcomes: [outcome({ job_id: 'RQ-1', merged: true })] }));
    expect(await run([])).toBe(0);
    const ds = parseRouterEvalDataset(stdout.join('\n'));
    expect(ds.jobs).toHaveLength(1);
  });

  it('--json prints the fold summary with source states', async () => {
    const { run, stdout } = harness(read({
      truncated: true,
      outcomes: [outcome({ job_id: 'RQ-1', merged: true, wall_s: 5 })],
    }));
    expect(await run(['--json'])).toBe(0);
    const summary = JSON.parse(stdout.join('\n')) as Record<string, unknown>;
    expect(summary).toMatchObject({
      schema: 'phm.eval-dataset.v1', jobs: 1, unattributed: 0,
      counts: { merged: 1, closed: 0, failed: 0, held: 0, pending: 0 },
    });
    const sources = summary['sources'] as Record<string, { state: string; truncated: boolean }>;
    expect(sources['jobs']).toMatchObject({ state: 'read', truncated: true });
    expect(sources['launchCost']).toMatchObject({ state: 'missing', truncated: false });
    expect(sources['reward']).toMatchObject({ state: 'missing', truncated: false });
  });

  it('refuses when the jobs ledger was not read', async () => {
    const { run, stderr } = harness(read({ state: 'missing', outcomes: [] }));
    expect(await run([])).toBe(1);
    expect(stderr.join('\n')).toContain('jobs ledger missing');
  });

  it('reports a read failure without echoing paths', async () => {
    const { run, stderr } = harness(new Error('boom'));
    expect(await run([])).toBe(1);
    expect(stderr.join('\n')).toContain('could not read the fleet outcome ledgers');
  });

  it('rejects unknown arguments and repeated flags', async () => {
    const { run, stderr } = harness(read());
    expect(await run(['--bogus'])).toBe(2);
    expect(await run(['--out'])).toBe(2);
    expect(stderr.join('\n')).toContain('unknown argument');
  });
});

describe('end-to-end ledger fold', () => {
  it('turns fixture jobs/work-market ledgers into a parseable dataset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-dataset-'));
    roots.push(root);
    mkdirSync(join(root, 'metrics'));
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), [
      // RQ-MERGED: full lifecycle through a MERGED outcome.
      JSON.stringify({ event: 'enqueue', job: 'RQ-MERGED', repo: 'phantom', lane: 'alpha', tier: 'work', ts: '2026-11-01T00:00:00Z' }),
      JSON.stringify({ event: 'claim', job: 'RQ-MERGED', repo: 'phantom', lane: 'alpha', tier: 'work', ts: '2026-11-01T00:01:00Z' }),
      JSON.stringify({ event: 'launch', job: 'RQ-MERGED', repo: 'phantom', lane: 'alpha', tier: 'work', model: 'm1', ts: '2026-11-01T00:01:30Z' }),
      JSON.stringify({ event: 'finish', job: 'RQ-MERGED', lane: 'alpha', wall_s: 600, exit_code: 0, empty: false, tokens_total: 4200, cost_usd: 0.5, ts: '2026-11-01T00:11:30Z' }),
      JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-MERGED', url: 'https://github.com/o/r/pull/1', mergedAt: '2026-11-01T01:00:00Z', ts: '2026-11-01T01:00:00Z' }),
      // RQ-CLOSED: explicit close evidence.
      JSON.stringify({ event: 'launch', job: 'RQ-CLOSED', repo: 'phantom', lane: 'beta', tier: 'mid', model: 'm2', ts: '2026-11-01T00:02:00Z' }),
      JSON.stringify({ event: 'outcome', state: 'CLOSED', job: 'RQ-CLOSED', url: 'https://github.com/o/r/pull/2', ts: '2026-11-01T02:00:00Z' }),
      // RQ-FAILED: nonzero exit, no outcome row.
      JSON.stringify({ event: 'launch', job: 'RQ-FAILED', repo: 'site', lane: 'alpha', tier: 'fast', model: 'm1', ts: '2026-11-01T00:03:00Z' }),
      JSON.stringify({ event: 'finish', job: 'RQ-FAILED', lane: 'alpha', wall_s: 45, exit_code: 1, ts: '2026-11-01T00:03:45Z' }),
      // RQ-EMPTY: clean exit but empty finish — a failed attempt.
      JSON.stringify({ event: 'launch', job: 'RQ-EMPTY', repo: 'site', lane: 'beta', tier: 'fast', model: 'm2', ts: '2026-11-01T00:04:00Z' }),
      JSON.stringify({ event: 'finish', job: 'RQ-EMPTY', lane: 'beta', wall_s: 30, exit_code: 0, empty: true, ts: '2026-11-01T00:04:30Z' }),
      // RQ-PENDING: launched and finished clean, no terminal verdict yet.
      JSON.stringify({ event: 'launch', job: 'RQ-PENDING', repo: 'phantom', lane: 'alpha', tier: 'work', model: 'm1', ts: '2026-11-01T00:05:00Z' }),
      JSON.stringify({ event: 'finish', job: 'RQ-PENDING', lane: 'alpha', wall_s: 120, exit_code: 0, empty: false, ts: '2026-11-01T00:07:00Z' }),
      // RQ-HELD: enqueued, never claimed.
      JSON.stringify({ event: 'enqueue', job: 'RQ-HELD', repo: 'site', lane: 'gamma', tier: 'fast', ts: '2026-11-01T00:06:00Z' }),
      // RQ-SKIP: skip-gate decline, never launched.
      JSON.stringify({ event: 'enqueue', job: 'RQ-SKIP', repo: 'site', lane: 'alpha', tier: 'work', ts: '2026-11-01T00:06:30Z' }),
      JSON.stringify({ event: 'skipped_empty', job: 'RQ-SKIP', repo: 'site', lane: 'alpha', reason: 'no_diff_expected', ts: '2026-11-01T00:06:45Z' }),
      '',
    ].join('\n'));
    writeFileSync(join(root, 'metrics', 'work-market.jsonl'), [
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'RQ-MERGED', chosen_lane: 'alpha', preferred_lane: 'beta', reason_codes: ['preferred_lane'], ts: 1761955260000 }),
      '',
    ].join('\n'));

    const readResult = await readRouterOutcomes({ runsDir: root, authorityEvidence: null });
    expect(readResult.state).toBe('read');

    const stdout: string[] = [];
    const code = await cmdEvalDataset([], {
      readOutcomes: async () => readResult,
      out: (t) => stdout.push(t),
      err: (t) => stdout.push(`ERR ${t}`),
      now: () => new Date('2026-11-02T00:00:00Z'),
    });
    expect(code).toBe(0);

    const ds = parseRouterEvalDataset(stdout.join('\n'));
    const byId = new Map(ds.jobs.map((j) => [j.id, j]));
    expect(byId.get('RQ-MERGED')).toMatchObject({ outcome: 'merged', chosen: 'alpha', pool: 'beta', repo: 'phantom', tier: 'work', costUsd: 0.5, tokens: 4200, wallTimeMs: 600000 });
    expect(byId.get('RQ-CLOSED')).toMatchObject({ outcome: 'closed', chosen: 'beta' });
    expect(byId.get('RQ-FAILED')).toMatchObject({ outcome: 'failed', chosen: 'alpha' });
    expect(byId.get('RQ-EMPTY')).toMatchObject({ outcome: 'failed', chosen: 'beta' });
    expect(byId.get('RQ-PENDING')).toMatchObject({ outcome: 'pending', chosen: 'alpha' });
    expect(byId.get('RQ-HELD')).toMatchObject({ outcome: 'held', chosen: null });
    expect(byId.get('RQ-SKIP')).toMatchObject({ outcome: 'held', chosen: null });
    // Every emitted line is a dataset job the harness accepts — already proven
    // by the parse above; spot-check the honesty fields stayed absent.
    expect(byId.get('RQ-PENDING')!.costUsd).toBeUndefined();
  });
});
