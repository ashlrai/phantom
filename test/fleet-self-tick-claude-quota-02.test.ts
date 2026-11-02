/**
 * RQ-PHX-SELFTICKCLAUDEQUOTA02 — the 'claude-quota' self-tick step: first in
 * every pass so reset-release, lane-autohold and the planner see a fresh
 * Claude weekly reading in the resource ledger, bounded to one probe per 30
 * minutes. Fake probes and temp runs dirs only — the real claude CLI is never
 * spawned, and fixtures carry no account details.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps,
} from '../src/core/fleet/self-tick.js';
import { claudeQuotaPath } from '../src/core/fleet/claude-quota-reading.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';
import type { ClaudeAccountStatusOptions } from '../src/core/resources/claude-account-status.js';

const NOW_MS = Date.parse('2026-11-02T12:00:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const RESET_AT = '2026-11-08T12:00:00Z';
const METRICS = () => claudeQuotaPath(runsDir);

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'self-tick-claude-quota-'));
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  // A stale hand-typed status value the fresh reading must replace.
  await writeFile(join(runsDir, 'queue', 'status.json'), JSON.stringify({
    last_tick: '2026-11-02T11:50:00Z', paused: false, mem_free_pct: 50,
    lanes: { claude: { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: false } },
    budget: { claude: { weekly_used_pct: 70 } },
  }));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

type FakeProbe = (options: ClaudeAccountStatusOptions) => Promise<ClaudeAccountUsageResult>;
const probeCounter = () => {
  let calls = 0;
  const probe: FakeProbe = async () => {
    calls += 1;
    return {
      schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed', reason: 'observed',
      loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'fixture-plan', accountHint: 'fixture-hint',
      startedAt: NOW_ISO, finishedAt: NOW_ISO, quotaFresh: true,
      windows: [
        { id: 'seven_day', usedPercent: 42, resetsAt: RESET_AT },
        { id: 'seven_day_sonnet', usedPercent: 9, resetsAt: RESET_AT },
      ],
    };
  };
  return { probe, calls: () => calls };
};

interface Deps {
  steps?: Partial<SelfTickSteps>;
  claudeProbe?: FakeProbe;
  claudeFindCommand?: () => string | null;
}
const run = async (args: string[], deps: Deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfTick(args, {
    now: () => NOW_MS, ...deps,
    output: (text) => out.push(text), error: (text) => err.push(text),
  });
  return { code, stdout: out.join('\n'),
    report: out[0]?.startsWith('{') ? JSON.parse(out[0]!) as {
      steps: { step: string; state: string; exitCode: number; report: unknown }[];
    } : null };
};

/** Stubs for the non-quota steps so each pass stays hermetic. */
const stubSteps = (order?: string[]): SelfTickSteps => {
  const stub = (name: string): SelfTickStep => async () => {
    order?.push(name);
    return { exitCode: 0, output: JSON.stringify({ ok: name }) };
  };
  return {
    'claude-quota': stub('claude-quota'), 'reset-release': stub('reset-release'),
    'lane-autohold': stub('lane-autohold'), 'planner-tick': stub('planner-tick'),
  };
};
/** The other steps stay faked; the real claude-quota step runs with fake probe+finder. */
const realQuotaDeps = (probe: FakeProbe, findCommand: () => string | null = () => '/fake/bin/claude'): Deps => {
  const stubs = stubSteps();
  return {
    steps: {
      'reset-release': stubs['reset-release'],
      'lane-autohold': stubs['lane-autohold'],
      'planner-tick': stubs['planner-tick'],
    },
    claudeProbe: probe, claudeFindCommand: findCommand,
  };
};

describe('fleet self-tick claude-quota step', () => {
  it('orders claude-quota first in the fixed step order', () => {
    expect([...SELF_TICK_STEP_ORDER]).toEqual(
      ['claude-quota', 'reset-release', 'lane-autohold', 'planner-tick']);
  });

  it('dry-run probes with the fake probe and writes nothing to metrics/', async () => {
    const counter = probeCounter();
    const { code, report } = await run(['--json', '--runs-dir', runsDir], realQuotaDeps(counter.probe));
    expect(code).toBe(0);
    expect(counter.calls()).toBe(1);
    expect(report!.steps[0]).toMatchObject({ step: 'claude-quota', state: 'ok', exitCode: 0 });
    expect(report!.steps[0]!.report).toMatchObject(
      { state: 'probed', fresh: true, weeklyPct: 42, observedAt: NOW_ISO });
    expect(existsSync(METRICS())).toBe(false);
  });

  it('--apply writes metrics/claude-quota.json and the ledger reports claude-native-usage', async () => {
    const counter = probeCounter();
    const { code, report } = await run(
      ['--apply', '--json', '--runs-dir', runsDir], realQuotaDeps(counter.probe));
    expect(code).toBe(0);
    expect(counter.calls()).toBe(1);
    expect(report!.steps[0]).toMatchObject({ step: 'claude-quota', state: 'ok' });
    const saved = JSON.parse(await readFile(METRICS(), 'utf8')) as {
      fresh: boolean; windows: { id: string; usedPct: number; resetAt: string | null }[];
    };
    expect(saved).toMatchObject({ v: 1, fresh: true, observedAt: NOW_ISO });
    expect(saved.windows).toContainEqual({ id: 'seven_day', usedPct: 42, resetAt: RESET_AT });
    const ledger = await readResourceLedger(
      { runsDir, now: () => NOW_MS, personalCodexHome: join(runsDir, 'none') });
    expect(ledger.lanes.find((l) => l.lane === 'claude'))
      .toMatchObject({ source: 'claude-native-usage', usedPct: 42, resetAt: RESET_AT });
  });

  it('a reading 10 minutes old is skipped-fresh and the probe is never called', async () => {
    await mkdir(join(runsDir, 'metrics'), { recursive: true });
    await writeFile(METRICS(), JSON.stringify({
      v: 1, observedAt: new Date(NOW_MS - 10 * 60_000).toISOString(),
      reason: 'observed', fresh: true,
      windows: [{ id: 'seven_day', usedPct: 33, resetAt: RESET_AT }],
    }));
    const counter = probeCounter();
    const { code, report } = await run(
      ['--apply', '--json', '--runs-dir', runsDir], realQuotaDeps(counter.probe));
    expect(code).toBe(0);
    expect(counter.calls()).toBe(0);
    expect(report!.steps[0]!.report).toMatchObject({ state: 'skipped-fresh', weeklyPct: 33 });
    // The stored reading is untouched — skipped-fresh never rewrites it.
    const saved = JSON.parse(await readFile(METRICS(), 'utf8')) as { windows: { usedPct: number }[] };
    expect(saved.windows[0]!.usedPct).toBe(33);
    const human = await run(['--apply', '--runs-dir', runsDir], realQuotaDeps(counter.probe));
    expect(human.stdout).toContain('skipped-fresh');
  });

  it('a missing claude command yields fresh:false and the step state ok', async () => {
    const counter = probeCounter();
    const deps = realQuotaDeps(counter.probe, () => null);
    const { code, report } = await run(['--json', '--runs-dir', runsDir], deps);
    expect(code).toBe(0);
    expect(counter.calls()).toBe(0);
    expect(report!.steps[0]).toMatchObject({ step: 'claude-quota', state: 'ok', exitCode: 0 });
    expect(report!.steps[0]!.report).toMatchObject(
      { state: 'probed', fresh: false, weeklyPct: null, reason: 'claude-not-found' });
    const human = await run(['--runs-dir', runsDir], deps);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('claude-quota  ok');
    expect(human.stdout).toContain('claude-not-found');
  });

  it('a throwing claude-quota step does not stop the later steps', async () => {
    const order: string[] = [];
    const steps = stubSteps(order);
    steps['claude-quota'] = async () => { order.push('claude-quota'); throw new Error('quota boom'); };
    const { code, report } = await run(['--json', '--runs-dir', runsDir], { steps });
    expect(code).toBe(1);
    expect(order).toEqual(['claude-quota', 'reset-release', 'lane-autohold', 'planner-tick']);
    expect(report!.steps[0]).toMatchObject({ step: 'claude-quota', state: 'failed', exitCode: 1 });
    expect(report!.steps.slice(1).map((s) => s.step))
      .toEqual(['reset-release', 'lane-autohold', 'planner-tick']);
    expect(report!.steps.slice(1).every((s) => s.state === 'ok')).toBe(true);
  });
});
