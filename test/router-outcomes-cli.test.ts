import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRouterOutcomesReport,
  cmdRouterOutcomes,
  routerOutcomeLines,
  ROUTER_OUTCOMES_USAGE,
} from '../src/cli/router-outcomes.js';
import { cmdRouter } from '../src/cli/router.js';
import { readRouterOutcomes, type RouterOutcome, type RouterOutcomeRead } from '../src/core/router/outcomes.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runsDir(ledger?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'router-outcomes-cli-'));
  roots.push(root);
  if (ledger !== undefined) {
    mkdirSync(join(root, 'metrics'));
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), ledger);
  }
  return root;
}

function outcome(job_id: string, over: Partial<RouterOutcome> = {}): RouterOutcome {
  return {
    schema: 'router.outcome.v1', job_id, lane: 'alpha', model: 'm1', tier: 'work', work_class: null,
    lane_hint: null, lane_override: null,
    merged: true, reverted: null, ci_first_pass: true, review_findings: null, cost_usd: 1.5, wall_s: 600,
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
    merge_queue: null,
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
    outcomes: [], malformed_rows: 0, unattached_rows: 0, ambiguous_urls: 0, session_rows: 0, truncated: false,
    ...over,
  };
}

type ReadOpts = Parameters<typeof readRouterOutcomes>[0];

/** A canned core read; opts are ignored. */
const canned = (result: RouterOutcomeRead): typeof readRouterOutcomes => async () => result;

/** Wraps a read implementation, capturing console output and the opts it receives. */
function harness(readImpl: typeof readRouterOutcomes) {
  const calls: ReadOpts[] = [];
  const readFn: typeof readRouterOutcomes = async (opts = {}) => {
    calls.push({ ...opts });
    return readImpl(opts);
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    calls, readFn,
    out: () => String(log.mock.calls.at(-1)?.[0] ?? ''),
    errs: () => err.mock.calls.map(c => String(c[0])).join('\n'),
  };
}

describe('phm router outcomes', () => {
  it('prints a router.outcomes.v1 report, newest first, and exits 0', async () => {
    const h = harness(canned(read({ outcomes: [outcome('A'), outcome('B'), outcome('C')] })));
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(0);
    const report = JSON.parse(h.out());
    expect(report).toMatchObject({
      schema: 'router.outcomes.v1', state: 'read', path: '/runs/metrics/jobs.jsonl',
      eval_state: 'missing', market_state: 'missing', market_truncated: false,
      total: 3, returned: 3, limit: 100,
      malformed_rows: 0, unattached_rows: 0, ambiguous_urls: 0, session_rows: 0,
    });
    expect(report.outcomes.map((o: RouterOutcome) => o.job_id)).toEqual(['C', 'B', 'A']);
  });

  it('bounds the page with --limit while total keeps the full count', async () => {
    const h = harness(canned(read({ outcomes: [outcome('A'), outcome('B'), outcome('C'), outcome('D'), outcome('E')] })));
    expect(await cmdRouterOutcomes(['--json', '--limit', '2'], h.readFn)).toBe(0);
    const report = JSON.parse(h.out());
    expect(report).toMatchObject({ total: 5, returned: 2, limit: 2 });
    expect(report.outcomes.map((o: RouterOutcome) => o.job_id)).toEqual(['E', 'D']);
  });

  it('passes --lane and --runs-dir through to the core read', async () => {
    const h = harness(canned(read({ outcomes: [outcome('A', { lane: 'alpha' })] })));
    expect(await cmdRouterOutcomes(['--json', '--lane', 'alpha', '--runs-dir', '/x'], h.readFn)).toBe(0);
    expect(h.calls).toEqual([{ runsDir: '/x', lane: 'alpha' }]);
    // Omitted flags stay absent rather than undefined-valued keys.
    const h2 = harness(canned(read()));
    await cmdRouterOutcomes(['--json'], h2.readFn);
    expect(h2.calls).toEqual([{}]);
  });

  it.each([
    { state: 'missing', code: 0 },
    { state: 'read', code: 0 },
    { state: 'unreadable', code: 1 },
    { state: 'not-file', code: 1 },
    { state: 'too-large', code: 1 },
  ] as const)('ledger state $state exits $code', async ({ state, code }) => {
    const h = harness(canned(read({ state })));
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(code);
    expect(JSON.parse(h.out()).state).toBe(state);
  });

  it('exits 1 when the ledger read itself fails', async () => {
    const h = harness(async () => { throw new Error('boom'); });
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(1);
    expect(h.errs()).toContain('Router outcomes unavailable.');
  });

  it.each([
    { args: ['--limit', '0'] },
    { args: ['--limit', '1001'] },
    { args: ['--limit', 'abc'] },
    { args: ['--limit', '1.5'] },
    { args: ['--runs-dir', 'relative/path'] },
    { args: ['--bogus'] },
    { args: ['--json', '--json'] },
    { args: ['--lane'] },
    { args: ['--lane', '--json'] },
  ])('rejects bad usage $args with exit 2 and never reads', async ({ args }) => {
    const h = harness(canned(read()));
    expect(await cmdRouterOutcomes(args, h.readFn)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.errs()).toContain(ROUTER_OUTCOMES_USAGE);
  });

  it('prints usage for --help without reading', async () => {
    const h = harness(canned(read()));
    expect(await cmdRouterOutcomes(['--help'], h.readFn)).toBe(0);
    expect(h.out()).toContain('Usage: ashlr router outcomes');
    expect(h.calls).toEqual([]);
  });

  it('renders text lines with unknown for null fields and review counts when present', async () => {
    const report = buildRouterOutcomesReport(read({
      outcomes: [
        outcome('A', { merged: null, reverted: true, cost_usd: null, wall_s: null, passk: null, task_outcome: 'done', lane_hint_blocked_by: ['quota_exhausted', 'saturated'], market_lane: 'beta', market_preferred: 'alpha', market_override: 'resource_fit', market_reasons: ['no_runnable_lane', 'global_admission'], market_rejected: [{ lane: 'alpha', reasons: ['quota_exhausted', 'held'] }, { lane: 'beta', reasons: null }], handoff_trigger: 'rate-limit', handoff_lane: 'codex-personal', handoff_target: null, provider_wall_trigger: 'auth-failure', provider_wall_pattern: 'claude_auth_401', provider_wall_lane: 'claude', review_findings: { fixed: 2, rejected: 1, ignored: 0 } }),
        outcome('B', { lane: null, model: null, tier: null, work_class: 'docs' }),
      ],
      malformed_rows: 3, unattached_rows: 1, ambiguous_urls: 2, session_rows: 4,
    }), 100);
    const lines = routerOutcomeLines(report);
    expect(lines[0]).toBe('router outcomes state=read eval=missing spend=missing market=missing empty_tags=missing merge_events=missing jobs=2 shown=2 truncated=false malformed=3 unattached=1 ambiguous_urls=2 session_rows=4');
    expect(lines[1]).toBe(`ledger ${report.path}`);
    expect(lines[3]).toContain('lane_hint_blocked_by=[quota_exhausted,saturated] market_lane=beta market_preferred=alpha market_override=resource_fit market_reasons=[no_runnable_lane,global_admission] market_rejected=[alpha:quota_exhausted+held;beta]');
    expect(lines[3]).toContain('handoff_trigger=rate-limit handoff_lane=codex-personal handoff_target=unknown');
    expect(lines[3]).toContain('provider_wall_trigger=auth-failure provider_wall_pattern=claude_auth_401 provider_wall_lane=claude');
    expect(lines[2]).toContain('B lane=unknown model=unknown tier=unknown work_class=docs lane_hint=unknown lane_override=unknown merged=true reverted=unknown');
    expect(lines[2]).toContain('task_outcome=unknown skipped=unknown skip_reason=unknown skip_code=unknown deferred=unknown defer_reason=unknown defer_repeat_of=unknown noop=unknown noop_reason=unknown noop_repeat_of=unknown lane_hint_blocked_by=unknown market_lane=unknown market_preferred=unknown market_override=unknown market_reasons=unknown market_rejected=unknown handoff_trigger=unknown handoff_lane=unknown handoff_target=unknown provider_wall_trigger=unknown provider_wall_pattern=unknown provider_wall_lane=unknown pool_kind=unknown pool_mem_free_pct=unknown pool_swap_gb=unknown merge_queue=unknown');
  });

  it('renders merge_queue evidence and reports merge-events ledger health', async () => {
    const mq = {
      events: 5, blocked_reasons: ['required_checks', 'conflict'], conflicts: 1,
      check_failures: 2, required_check_failures: 1, retries: 1, retry_failures: 0,
      recuts: 0, auto_merge: 'enabled' as const,
    };
    const report = buildRouterOutcomesReport(read({
      outcomes: [outcome('A', { merge_queue: mq })], merge_events_state: 'read', merge_events_truncated: true,
    }), 100);
    expect(report).toMatchObject({ merge_events_state: 'read', merge_events_truncated: true });
    const lines = routerOutcomeLines(report);
    expect(lines[0]).toContain('merge_events=read');
    expect(lines).toContain('merge-event coverage: retained tail only; merge_queue joins cover the newest bytes');
    expect(lines[3]).toContain('merge_queue=events:5,blocked:[required_checks,conflict],conflicts:1,check_failures:2,required_check_failures:1,retries:1,retry_failures:0,recuts:0,auto_merge:enabled');

    const h = harness(canned(read({ outcomes: [outcome('A')], merge_events_state: 'unreadable' })));
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ merge_events_state: 'unreadable', merge_events_truncated: false });
  });

  it('surfaces truncated coverage in JSON and text without changing exit 0', async () => {
    const report = buildRouterOutcomesReport(read({ outcomes: [outcome('A')], truncated: true }), 100);
    expect(report.truncated).toBe(true);
    const lines = routerOutcomeLines(report);
    expect(lines[0]).toContain('truncated=true');
    expect(lines).toContain('coverage: retained tail only; older ledger rows were not read');

    const h = harness(canned(read({ outcomes: [outcome('A')], truncated: true })));
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ state: 'read', truncated: true, total: 1 });
  });

  it('surfaces spend ledger health and cut-tail coverage in JSON and text', async () => {
    const report = buildRouterOutcomesReport(read({
      outcomes: [outcome('A')], spend_state: 'read', spend_truncated: true,
    }), 100);
    expect(report).toMatchObject({ spend_state: 'read', spend_truncated: true });
    const lines = routerOutcomeLines(report);
    expect(lines[0]).toContain('spend=read');
    expect(lines).toContain('spend coverage: retained tail only; per-job costs are lower bounds');

    const h = harness(canned(read({ outcomes: [outcome('A')], spend_state: 'unreadable' })));
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ spend_state: 'unreadable', spend_truncated: false });
  });

  it('surfaces market ledger health and cut-tail coverage in JSON and text', async () => {
    const report = buildRouterOutcomesReport(read({
      outcomes: [outcome('A', { work_class: 'bulk' })], market_state: 'read', market_truncated: true,
    }), 100);
    expect(report).toMatchObject({ market_state: 'read', market_truncated: true });
    const lines = routerOutcomeLines(report);
    expect(lines[0]).toContain('market=read');
    expect(lines).toContain('market coverage: retained tail only; work_class joins cover the newest bytes');

    const h = harness(canned(read({ outcomes: [outcome('A')], market_state: 'unreadable' })));
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ market_state: 'unreadable', market_truncated: false });
  });

  it('surfaces empty-tag ledger health and cut-tail coverage in JSON and text', async () => {
    const report = buildRouterOutcomesReport(read({
      outcomes: [outcome('A', { empty_tag: 'already_done' })], empty_tag_state: 'read', empty_tag_truncated: true,
    }), 100);
    expect(report).toMatchObject({ empty_tag_state: 'read', empty_tag_truncated: true });
    const lines = routerOutcomeLines(report);
    expect(lines[0]).toContain('empty_tags=read');
    expect(lines).toContain('empty-tag coverage: retained tail only; empty_tag joins cover the newest bytes');
    expect(lines[3]).toContain('empty_tag=already_done');

    const h = harness(canned(read({ outcomes: [outcome('A')], empty_tag_state: 'unreadable' })));
    expect(await cmdRouterOutcomes(['--json'], h.readFn)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ empty_tag_state: 'unreadable', empty_tag_truncated: false });
  });

  it('folds a real ledger end-to-end through cmdRouter and cmdRouterOutcomes', async () => {
    const root = runsDir([
      '{"job":"J1","event":"enqueue","ts":"2026-10-31T23:00:00Z"}',
      '{"job":"J1","event":"launch","lane":"alpha","ts":"2026-10-31T23:30:00Z"}',
      '{"job":"J1","event":"ci_start","ts":"2026-10-31T23:45:00Z"}',
      '{"job":"J1","event":"ci_complete","ts":"2026-10-31T23:55:00Z"}',
      '{"job":"J1","lane":"alpha","model":"m1","tier":"work","phase":"MERGED","ts":"2026-11-01T00:00:00Z","mergedAt":"2026-11-01T01:00:00Z","cost_usd":1.25,"wall_s":900,"tokens_total":123456,"ttm_s":5400,"ci_first_pass":true}',
      '{"job":"J2","lane":"beta","model":"m2","phase":"CLOSED","ts":"2026-11-02T00:00:00Z"}',
      // A batch session: infrastructure rows never mint outcomes, while the
      // member's own claim/task_outcome rows fold under its job id.
      '{"job":"RQ-BATCH-e2e0001","event":"launch","lane":"alpha","wall_s":800,"tokens_total":40000}',
      '{"job":"RQ-BATCH-e2e0001","event":"finish","lane":"alpha","wall_s":800,"pr_url":"https://github.com/o/r/pull/42"}',
      '{"job":"M1","event":"batch_claim","batch":"RQ-BATCH-e2e0001","lane":"alpha","tier":"work"}',
      '{"job":"M1","event":"task_outcome","batch":"RQ-BATCH-e2e0001","lane":"alpha","outcome":"failed"}',
      'not json',
    ].join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Dispatch through the parent command proves the verb is wired.
    expect(await cmdRouter(['outcomes', '--runs-dir', root, '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report).toMatchObject({
      schema: 'router.outcomes.v1', state: 'read', total: 3, returned: 3,
      malformed_rows: 1, session_rows: 2, eval_state: 'missing',
    });
    // Newest first: M1 (appended last) leads, then J2, then J1.
    expect(report.outcomes.map((o: RouterOutcome) => o.job_id)).toEqual(['M1', 'J2', 'J1']);
    expect(report.outcomes[0]).toMatchObject({ lane: 'alpha', merged: null, task_outcome: 'failed', wall_s: null, tokens_total: null });
    expect(report.outcomes[2]).toMatchObject({ lane: 'alpha', model: 'm1', merged: true, cost_usd: 1.25, wall_s: 900, tokens_total: 123456, ttm_s: 5400, queue_wait_s: 1800, ci_wall_s: 600, publish_wait_s: null, ci_first_pass: true, passk: null, task_outcome: null });
    expect(report.outcomes[1]).toMatchObject({ lane: 'beta', merged: false, cost_usd: null });

    const laneFiltered = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdRouterOutcomes(['--runs-dir', root, '--lane', 'alpha', '--json'])).toBe(0);
    const filtered = JSON.parse(String(laneFiltered.mock.calls.at(-1)![0]));
    expect(filtered.total).toBe(2);
    expect(filtered.outcomes.map((o: RouterOutcome) => o.job_id)).toEqual(['M1', 'J1']);
  });

  it('reports a missing ledger as state=missing with exit 0', async () => {
    const h = harness(readRouterOutcomes);
    expect(await cmdRouterOutcomes(['--json', '--runs-dir', runsDir()], h.readFn)).toBe(0);
    const report = JSON.parse(h.out());
    expect(report).toMatchObject({ state: 'missing', total: 0, returned: 0, outcomes: [] });
  });
});
