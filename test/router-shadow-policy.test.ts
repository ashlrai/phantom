import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateRoutingPolicy } from '../scripts/evaluators/routing-off-policy.mjs';
import { cmdRoute } from '../src/cli/route.js';
import { explainRoutes } from '../src/core/queue/route-explain.js';
import type { RouterOutcome } from '../src/core/router/outcomes.js';
import {
  buildShadowPolicyReport, evaluateShadowPolicy, recordShadowPolicyDecision,
  SHADOW_POLICY_LEDGER_RELATIVE, SHADOW_POLICY_RECORD_SCHEMA, SHADOW_POLICY_REPORT_SCHEMA,
} from '../src/core/router/shadow-policy.js';
import { decideRoute } from '../src/core/routing/decision.js';
import type { RouteSources } from '../src/core/routing/decision-candidates.js';
import type { RouteRequest } from '../src/core/routing/decision-schema.js';

let root: string;
let runs: string;
let logged: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'router-shadow-policy-'));
  runs = join(root, 'runs');
  mkdirSync(join(runs, 'queue'), { recursive: true });
  mkdirSync(join(runs, 'metrics'), { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  vi.stubEnv('PHANTOM_ROUTE_DISABLE_MODELS', '1');
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const mkRequest = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  job: 'RQ-SHADOW-1', task_class: 'bug-fix', repo: 'phantom', tier_hint: 'work',
  lane_candidates: ['alpha', 'beta'],
  quota_state: { alpha: 'available', beta: 'available' },
  machine_state: { admit: true, running_by_lane: { alpha: 0, beta: 0 } },
  ...over,
});

const mkSources = (models: Record<string, string> = { alpha: 'gpt-6.1-sol', beta: 'gpt-6.1-sol' }): RouteSources => ({
  models,
  slots: { alpha: { target: 2, hard_cap: 2 }, beta: { target: 2, hard_cap: 2 } },
  admission: { admit: true },
});

const mkOutcome = (job_id: string, lane: string, merged: boolean | null, over: Partial<RouterOutcome> = {}): RouterOutcome => ({
  job_id, lane, repo: 'phantom', work_class: 'bug-fix', merged, reverted: false,
  ...over,
} as RouterOutcome);

describe('evaluateShadowPolicy', () => {
  it('switches to a supported lower-failure-rate lane for the same repo and task_class without changing live routing', async () => {
    const req = mkRequest();
    const sources = mkSources();
    const live = await decideRoute(req, sources, { backends: [], nowMs: 1_700_000_000_000 });
    expect('lane' in live && live.lane).toBe('alpha');
    const outcomes = [
      mkOutcome('j1', 'alpha', false), mkOutcome('j2', 'alpha', false), mkOutcome('j3', 'alpha', true),
      mkOutcome('j4', 'beta', true), mkOutcome('j5', 'beta', true), mkOutcome('j6', 'beta', true),
      // Different repo and different task_class must not leak into this decision.
      mkOutcome('j7', 'beta', false, { repo: 'other-repo' }),
      mkOutcome('j8', 'beta', false, { work_class: 'refactor' }),
      mkOutcome('j9', 'alpha', null),
    ];
    const shadow = evaluateShadowPolicy(req, sources, live as { lane: string | null }, outcomes, { nowMs: 1_700_000_000_000 });
    expect(shadow).toMatchObject({
      schema: SHADOW_POLICY_RECORD_SCHEMA, advisory: true, dispatched: false,
      live_lane: 'alpha', shadow_lane: 'beta', disagreed: true, support_status: 'supported',
      reason_codes: ['task_class_failure_avoidance', 'no_escalation'],
    });
    expect(shadow.lane_stats).toEqual([
      expect.objectContaining({ lane: 'alpha', resolved: 3, failures: 2, unknown: 1, failure_rate: 0.6667, supported: true }),
      expect.objectContaining({ lane: 'beta', resolved: 3, failures: 0, unknown: 0, failure_rate: 0, supported: true }),
    ]);
  });

  it('reports insufficient_support separately and refuses automatic provider/cost escalation', async () => {
    const req = mkRequest();
    const live = { lane: 'alpha' };
    // Sparse outcomes -> insufficient_support, stays on live_lane.
    const sparse = evaluateShadowPolicy(req, mkSources(), live, [mkOutcome('j1', 'alpha', false), mkOutcome('j2', 'beta', true)]);
    expect(sparse).toMatchObject({ shadow_lane: 'alpha', disagreed: false, support_status: 'insufficient_support' });
    // Unknown-only outcomes -> failure_rate stays null.
    const unknownOnly = evaluateShadowPolicy(req, mkSources(), live, [mkOutcome('j1', 'alpha', null), mkOutcome('j2', 'alpha', null), mkOutcome('j3', 'alpha', null)]);
    expect(unknownOnly.lane_stats[0]?.failure_rate).toBeNull();
    expect(unknownOnly.support_status).toBe('insufficient_support');
    // Higher-tier/cost alternative (premium vs workhorse) is excluded from automatic escalation.
    const escalatedSources = mkSources({ alpha: 'gpt-6.1-sol', beta: 'claude-opus-4-6' });
    const outcomes = [
      mkOutcome('j1', 'alpha', false), mkOutcome('j2', 'alpha', false), mkOutcome('j3', 'alpha', false),
      mkOutcome('j4', 'beta', true), mkOutcome('j5', 'beta', true), mkOutcome('j6', 'beta', true),
    ];
    const noEsc = evaluateShadowPolicy(req, escalatedSources, live, outcomes);
    expect(noEsc).toMatchObject({ shadow_lane: 'alpha', disagreed: false, support_status: 'insufficient_support', reason_codes: ['no_supported_alternative'] });
  });
});

describe('buildShadowPolicyReport and CLI', () => {
  it('compares recorded shadow choices on recorded outcomes, keeps unknowns null, and matches routing-off-policy.mjs', async () => {
    const missing = await buildShadowPolicyReport({ runsDir: runs });
    expect(missing).toMatchObject({ schema: SHADOW_POLICY_REPORT_SCHEMA, state: 'missing', total_decisions: 0 });
    expect(missing.outcomes.live_good_rate).toBeNull();
    expect(missing.off_policy.ips).toBeNull();

    const base = evaluateShadowPolicy(mkRequest({ job: 'RQ-A' }), mkSources(), { lane: 'alpha' }, []);
    await recordShadowPolicyDecision(runs, { ...base, job: 'RQ-1', live_lane: 'alpha', shadow_lane: 'beta', disagreed: true, support_status: 'supported', behavior_propensities: { alpha: 0.5, beta: 0.5 } });
    await recordShadowPolicyDecision(runs, { ...base, job: 'RQ-2', live_lane: 'beta', shadow_lane: 'beta', disagreed: false, support_status: 'supported', behavior_propensities: { alpha: 0.5, beta: 0.5 } });
    // Deterministic disagreement has zero behavior support -> counted in unsupported_rows.
    await recordShadowPolicyDecision(runs, { ...base, job: 'RQ-3', live_lane: 'alpha', shadow_lane: 'beta', disagreed: true, support_status: 'supported' });
    // Unresolved job -> unknown outcome stays null (never counted in resolved).
    await recordShadowPolicyDecision(runs, { ...base, job: 'RQ-UNK', live_lane: 'alpha', shadow_lane: 'alpha', disagreed: false, support_status: 'insufficient_support' });
    // Cross-repo outcome for RQ-XREPO must not join.
    await recordShadowPolicyDecision(runs, { ...base, job: 'RQ-XREPO', repo: 'phantom', live_lane: 'alpha', shadow_lane: 'alpha', disagreed: false, support_status: 'supported' });

    const ledgerRows = [
      { event: 'claim', ts: 100, job: 'RQ-1', lane: 'alpha', repo: 'phantom' },
      { event: 'outcome', ts: 101, job: 'RQ-1', lane: 'alpha', repo: 'phantom', phase: 'CLOSED' },
      { event: 'claim', ts: 102, job: 'RQ-2', lane: 'beta', repo: 'phantom' },
      { event: 'outcome', ts: 103, job: 'RQ-2', lane: 'beta', repo: 'phantom', phase: 'MERGED' },
      { event: 'claim', ts: 104, job: 'RQ-3', lane: 'alpha', repo: 'phantom' },
      { event: 'outcome', ts: 105, job: 'RQ-3', lane: 'alpha', repo: 'phantom', phase: 'MERGED' },
      { event: 'claim', ts: 106, job: 'RQ-UNK', lane: 'alpha', repo: 'phantom' },
      { event: 'outcome', ts: 107, job: 'RQ-XREPO', lane: 'alpha', repo: 'other-repo', phase: 'MERGED' },
    ];
    writeFileSync(join(runs, 'metrics/jobs.jsonl'), ledgerRows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const report = await buildShadowPolicyReport({ runsDir: runs });
    const ref = evaluateRoutingPolicy([
      { action: 'alpha', reward: 0, behavior: { alpha: 0.5, beta: 0.5 }, target: { alpha: 0, beta: 1 } },
      { action: 'beta', reward: 1, behavior: { alpha: 0.5, beta: 0.5 }, target: { alpha: 0, beta: 1 } },
    ]);
    expect(report).toMatchObject({
      schema: SHADOW_POLICY_REPORT_SCHEMA, state: 'read', advisory: true, dispatched: false,
      total_decisions: 5, agreed: 3, disagreed: 2, insufficient_support: 1,
      outcomes: { resolved: 3, unknown: 2, live_good_rate: 0.6667, agreed_good_rate: 1, disagreed_live_good_rate: 0.5 },
      off_policy: { observations: 3, supported_rows: 2, unsupported_rows: 1, ips: ref.ips, snips: ref.snips, effective_sample_size: ref.effectiveSampleSize, max_weight: ref.maxWeight },
      promotion_gate: { ready: false, causal_claim: false, requires_prospective_matched_evidence: true, automatic_escalation: false },
    });

    // route explain surfaces shadow_comparison when ledger exists.
    expect((await explainRoutes(runs)).shadow_comparison).toMatchObject({ schema: SHADOW_POLICY_REPORT_SCHEMA, total_decisions: 5 });
  });

  it('runs phm route shadow eval --record and report via CLI and degrades cleanly on symlinks', async () => {
    writeFileSync(join(runs, 'models.json'), JSON.stringify({ alpha: 'gpt-6.1-sol', beta: 'gpt-6.1-sol' }));
    writeFileSync(join(runs, 'queue/slots.json'), JSON.stringify({ alpha: { target: 2, hard_cap: 2 }, beta: { target: 2, hard_cap: 2 } }));
    writeFileSync(join(runs, 'queue/admission.json'), '{"admit":true}');
    const reqPath = join(root, 'req.json');
    writeFileSync(reqPath, JSON.stringify(mkRequest({ job: 'RQ-CLI-1' })));

    expect(await cmdRoute(['shadow', 'eval', '--input', reqPath, '--root', runs, '--record', '--json'])).toBe(0);
    const evalOut = JSON.parse(logged.at(-1)!);
    expect(evalOut).toMatchObject({ schema: 'route.shadow-eval.v1', advisory: true, dispatched: false, recorded: true, live: { lane: 'alpha' }, shadow: { live_lane: 'alpha', dispatched: false } });

    expect(await cmdRoute(['shadow', 'report', '--root', runs, '--json'])).toBe(0);
    const repOut = JSON.parse(logged.at(-1)!);
    expect(repOut).toMatchObject({ schema: SHADOW_POLICY_REPORT_SCHEMA, total_decisions: 1, outcomes: { resolved: 0, unknown: 1, live_good_rate: null } });

    expect(await cmdRoute(['shadow', 'unknown'])).toBe(2);
    expect(await cmdRoute(['shadow', 'report', '--policy', 'bogus', '--root', runs, '--json'])).toBe(2);

    // Symlink shadow ledger fails closed (O_NOFOLLOW -> unreadable).
    const linkTarget = join(root, 'outside.jsonl');
    writeFileSync(linkTarget, '{}\n');
    rmSync(join(runs, SHADOW_POLICY_LEDGER_RELATIVE));
    symlinkSync(linkTarget, join(runs, SHADOW_POLICY_LEDGER_RELATIVE));
    expect((await buildShadowPolicyReport({ runsDir: runs })).state).toBe('unreadable');
  });
});
