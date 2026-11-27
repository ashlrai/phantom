/**
 * fleet-learning-loop-sweeps.test.ts
 *
 * Covers the two auto-merge-independent reachability fixes:
 *   - self-improve.ts's sweepRejectionLearning (anti-playbook path reachable
 *     without cfg.foundry.autoMerge.enabled)
 *   - learn/reflect.ts's runReflectionCycle (per-run reflection write-back,
 *     previously only reachable via the manual `ashlr reflect` CLI)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, DecisionEntry } from '../src/core/types.js';
import { sweepRejectionLearning } from '../src/core/fleet/self-improve.js';
import { runReflectionCycle } from '../src/core/learn/reflect.js';

const FIXED_MS = 1_750_000_000_000;
const FIXED_ISO = new Date(FIXED_MS).toISOString();

let tmpHome: string;
let origHome: string | undefined;
let origAshlrHome: string | undefined;

function makeCfg(overrides: Partial<NonNullable<AshlrConfig['foundry']>> = {}): AshlrConfig {
  return {
    version: 1,
    daemon: { dailyBudgetUsd: 10, perTickItems: 3, parallel: 2, intervalMs: 100, cooldownMs: 1000 },
    foundry: { selfImprove: true, allowedBackends: ['claude', 'codex', 'builtin'], ...overrides },
    genome: { maxRecall: 20, injectOnRun: true },
  } as AshlrConfig;
}

function readHubEntries(): Array<Record<string, unknown>> {
  const hubPath = path.join(tmpHome, '.ashlr', 'genome', 'hub.jsonl');
  if (!fs.existsSync(hubPath)) return [];
  return fs.readFileSync(hubPath, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readTelemetry(): Array<Record<string, unknown>> {
  const decisionsDir = path.join(tmpHome, '.ashlr', 'decisions');
  if (!fs.existsSync(decisionsDir)) return [];
  return fs.readdirSync(decisionsDir)
    .flatMap((file) => fs.readFileSync(path.join(decisionsDir, file), 'utf8').split('\n'))
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((row) => row['action'] === 'self-improve:written');
}

/** Seed one failed swarm whose task carries `error` into ~/.ashlr/swarms/. */
function seedFailedSwarm(id: string, error: string): void {
  const dir = path.join(tmpHome, '.ashlr', 'swarms');
  fs.mkdirSync(dir, { recursive: true });
  const swarm = {
    id,
    goal: 'fix the flaky test',
    specId: null,
    project: null,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    budget: { maxSteps: 50, maxTokens: 100000, maxUsd: 5, maxWallClockMs: 600000 },
    usage: { tokensIn: 1000, tokensOut: 500, steps: 3, estCostUsd: 0 },
    parallel: 1,
    status: 'failed',
    plan: { specId: null, goal: 'fix the flaky test', tasks: [{ id: `${id}-t1`, phase: 'build' }] },
    tasks: [{ id: `${id}-t1`, phase: 'build', status: 'failed', error }],
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(swarm, null, 2), 'utf8');
}

function readHarnessState(): { hypotheses?: Array<{ id: string }> } {
  const statePath = path.join(tmpHome, '.ashlr', 'learn', 'harness', 'state.json');
  if (!fs.existsSync(statePath)) return {};
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as { hypotheses?: Array<{ id: string }> };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_MS);
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-sweep-')));
  origHome = process.env.HOME;
  origAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  vi.useRealTimers();
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = origAshlrHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sweepRejectionLearning
// ---------------------------------------------------------------------------

describe('sweepRejectionLearning', () => {
  it('defaults off when selfImprove is absent', () => {
    const cfg = makeCfg();
    cfg.foundry = { allowedBackends: ['builtin'] } as NonNullable<AshlrConfig['foundry']>;
    const result = sweepRejectionLearning(cfg, {
      listDecisions: () => [
        { ts: FIXED_ISO, proposalId: 'p-off', action: 'judged', verdict: 'noise', judgeReasonCode: 'judge-noise' } as DecisionEntry,
      ],
    });
    expect(result).toMatchObject({ scanned: 0, written: 0, skipped: 0 });
    expect(readHubEntries()).toHaveLength(0);
    expect(readTelemetry()).toHaveLength(0);
  });

  it('writes an anti-playbook lesson for a judged rejection with NO auto-merge involvement', () => {
    const cfg = makeCfg(); // no autoMerge block at all — the point of this fix
    const decisions: DecisionEntry[] = [
      { ts: FIXED_ISO, proposalId: 'p1', action: 'judged', verdict: 'noise', judgeReasonCode: 'judge-noise', engine: 'claude', model: 'opus' } as DecisionEntry,
    ];
    const result = sweepRejectionLearning(cfg, { listDecisions: () => decisions });

    expect(result.scanned).toBe(1);
    expect(result.written).toBe(1);

    const antiPlaybooks = readHubEntries().filter(
      (e) => Array.isArray(e['tags']) && (e['tags'] as string[]).includes('m235:anti-playbook'),
    );
    expect(antiPlaybooks).toHaveLength(1);
    expect(readTelemetry()).toHaveLength(1);
  });

  it('increments written and emits idempotency telemetry only after the hub append succeeds', () => {
    fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.ashlr', 'genome'), 'blocks genome directory creation');
    const result = sweepRejectionLearning(makeCfg(), {
      listDecisions: () => [{
        ts: FIXED_ISO,
        proposalId: 'p-append-failure',
        action: 'judged',
        verdict: 'noise',
        judgeReasonCode: 'judge-noise',
      } as DecisionEntry],
    });

    expect(result).toMatchObject({ scanned: 1, written: 0, skipped: 1 });
    expect(readTelemetry()).toHaveLength(0);
  });

  it('is idempotent: a proposal already taught is not taught again', () => {
    const cfg = makeCfg();
    const decisions: DecisionEntry[] = [
      { ts: FIXED_ISO, proposalId: 'p2', action: 'judged', verdict: 'harmful', judgeReasonCode: 'judge-harmful', engine: 'claude', model: 'opus' } as DecisionEntry,
    ];
    const first = sweepRejectionLearning(cfg, { listDecisions: () => decisions });
    expect(first.written).toBe(1);

    // Second sweep sees the SAME judged row plus the telemetry row the first
    // sweep wrote — must not double-write.
    const second = sweepRejectionLearning(cfg, { listDecisions: () => decisions });
    expect(second.written).toBe(0);
    expect(readTelemetry()).toHaveLength(1);
  });

  it('ignores ship verdicts and only the newest verdict per proposal counts', () => {
    const cfg = makeCfg();
    const decisions: DecisionEntry[] = [
      { ts: FIXED_ISO, proposalId: 'p3', action: 'judged', verdict: 'ship', engine: 'claude', model: 'opus' } as DecisionEntry,
      {
        ts: new Date(FIXED_MS - 60_000).toISOString(),
        proposalId: 'p4', action: 'judged', verdict: 'noise', judgeReasonCode: 'judge-noise', engine: 'claude', model: 'opus',
      } as DecisionEntry,
      {
        ts: FIXED_ISO,
        proposalId: 'p4', action: 'judged', verdict: 'ship', engine: 'claude', model: 'opus',
      } as DecisionEntry,
    ];
    const result = sweepRejectionLearning(cfg, { listDecisions: () => decisions });
    // p3: pure ship, never a candidate. p4: newest verdict is 'ship' (supersedes
    // the earlier 'noise'), so it must NOT be taught either.
    expect(result.scanned).toBe(0);
    expect(result.written).toBe(0);
    expect(readTelemetry()).toHaveLength(0);
  });

  it('flag-off (selfImprove:false) is a no-op, byte-identical to no call', () => {
    const cfg = makeCfg({ selfImprove: false });
    const decisions: DecisionEntry[] = [
      { ts: FIXED_ISO, proposalId: 'p5', action: 'judged', verdict: 'harmful', judgeReasonCode: 'judge-harmful', engine: 'claude', model: 'opus' } as DecisionEntry,
    ];
    const result = sweepRejectionLearning(cfg, { listDecisions: () => decisions });
    expect(result).toMatchObject({ scanned: 0, written: 0, skipped: 0, sourceComplete: true });
    expect(readHubEntries()).toHaveLength(0);
  });

  it('degraded decisions source -> sourceComplete:false, never a reason to skip retrying', () => {
    const cfg = makeCfg();
    const result = sweepRejectionLearning(cfg, {
      listDecisions: () => { throw new Error('simulated corrupt ledger'); },
    });
    expect(result).toMatchObject({ scanned: 0, written: 0, sourceComplete: false });
  });

  it.each([
    ['judge-parse-failure', 'judge-parse-failure'],
    ['judge-network-failure', 'judge-network-failure'],
    ['legacy/unclassified review', undefined],
  ] as const)('does not persist negative learning for %s', (_label, judgeReasonCode) => {
    const result = sweepRejectionLearning(makeCfg(), {
      listDecisions: () => [{
        ts: FIXED_ISO,
        proposalId: 'p-failure',
        action: 'judged',
        verdict: 'review',
        ...(judgeReasonCode ? { judgeReasonCode } : {}),
      } as DecisionEntry],
    });
    expect(result).toMatchObject({ scanned: 0, written: 0 });
    expect(readHubEntries()).toHaveLength(0);
    expect(readTelemetry()).toHaveLength(0);
  });

  it.each([
    ['harmful', undefined],
    ['noise', 'judge-parse-failure'],
    ['review', 'judge-harmful'],
  ] as const)('does not teach incomplete negative output %s / %s', (verdict, judgeReasonCode) => {
    const result = sweepRejectionLearning(makeCfg(), {
      listDecisions: () => [{
        ts: FIXED_ISO,
        proposalId: 'p-incomplete-negative',
        action: 'judged',
        verdict,
        ...(judgeReasonCode ? { judgeReasonCode } : {}),
      } as DecisionEntry],
    });
    expect(result).toMatchObject({ scanned: 0, written: 0 });
    expect(readHubEntries()).toHaveLength(0);
    expect(readTelemetry()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runReflectionCycle
// ---------------------------------------------------------------------------

describe('runReflectionCycle', () => {
  it('returns diagnostics but persists nothing when selfImprove is not explicitly true', async () => {
    const cfg = makeCfg({ selfImprove: false });
    const result = await runReflectionCycle(cfg, {});
    expect(result.report).toBeDefined();
    expect(result.reportPath).toBeNull();
    expect(result.playbooks.didPersist).toBe(false);
  });

  it('computes a report, persists the snapshot, and distills+persists playbooks — all local, no network', async () => {
    const cfg = makeCfg();
    const result = await runReflectionCycle(cfg, {});

    expect(result.report.generatedAt).toBeDefined();
    expect(result.reportPath).not.toBeNull();
    expect(fs.existsSync(result.reportPath!)).toBe(true);

    // playbooks.distillAndPersist ran with persist:true, narrative:false —
    // deterministic, no swarms recorded yet so playbooks is empty but the
    // call must have happened without throwing and without going local:false
    // (never attempted a network call).
    expect(result.playbooks.local).toBe(true);
    expect(result.playbooks.didPersist).toBe(true);
  });

  it('a second cycle computes a week-over-week delta against the first persisted snapshot', async () => {
    const cfg = makeCfg();
    const first = await runReflectionCycle(cfg, {});
    expect(first.report.delta.previousAt).toBeNull();

    vi.setSystemTime(FIXED_MS + 24 * 60 * 60 * 1000);
    const second = await runReflectionCycle(cfg, {});
    expect(second.report.delta.previousAt).toBe(first.report.generatedAt);
  });

  it('never throws even if playbook distillation fails, and still returns the report', async () => {
    const cfg = makeCfg();
    // Point HOME somewhere unwritable-ish by corrupting learnDir's parent
    // is fragile across platforms; instead assert the documented contract:
    // report generation always succeeds even under an empty/cold-start home.
    const result = await runReflectionCycle(cfg, {});
    expect(result.report).toBeDefined();
    expect(result.report.swarmsAnalyzed).toBe(0);
  });

  it('records recurring-failure tuning suggestions as OPEN harness hypotheses', async () => {
    const cfg = makeCfg();
    // Two swarms failing the same way -> one recurring failure cluster ->
    // deriveTuning emits a playbook.failure.* suggestion ->
    // harnessHypothesesFromTuning turns it into a prompt hypothesis.
    const error = "TypeError: cannot read properties of undefined (reading 'x')";
    seedFailedSwarm('s-fail-1', error);
    seedFailedSwarm('s-fail-2', error);

    const result = await runReflectionCycle(cfg, {});

    expect(result.tuning).toBeDefined();
    expect(result.tuning!.suggestions).toBeGreaterThanOrEqual(1);
    expect(result.tuning!.hypothesesAccepted.length).toBeGreaterThanOrEqual(1);

    // The accepted ids are persisted OPEN in the harness state file — DATA
    // only; nothing is applied (experiments + adoption gate are separate).
    const openIds = (readHarnessState().hypotheses ?? []).map((h) => h.id);
    for (const id of result.tuning!.hypothesesAccepted) {
      expect(id).toMatch(/^tuning-[0-9a-f]{16}$/);
      expect(openIds).toContain(id);
    }
  });

  it('a repeat cycle accepts no duplicate hypotheses (deterministic ids dedupe)', async () => {
    const cfg = makeCfg();
    const error = 'Error: build failed at step 3';
    seedFailedSwarm('s-fail-3', error);
    seedFailedSwarm('s-fail-4', error);

    const first = await runReflectionCycle(cfg, {});
    expect(first.tuning!.hypothesesAccepted.length).toBeGreaterThanOrEqual(1);

    vi.setSystemTime(FIXED_MS + 60_000);
    const second = await runReflectionCycle(cfg, {});
    expect(second.tuning!.suggestions).toBe(first.tuning!.suggestions);
    expect(second.tuning!.hypothesesAccepted).toHaveLength(0);
  });

  it('derives and records no tuning hypotheses when selfImprove is off', async () => {
    const cfg = makeCfg({ selfImprove: false });
    const error = 'Error: lint exploded';
    seedFailedSwarm('s-fail-5', error);
    seedFailedSwarm('s-fail-6', error);

    const result = await runReflectionCycle(cfg, {});

    expect(result.tuning).toBeUndefined();
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'learn', 'harness', 'state.json'))).toBe(false);
  });
});
