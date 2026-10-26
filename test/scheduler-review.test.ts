import { describe, expect, it, vi } from 'vitest';
import { applyOverrides, embeddedSchedulerConfig, parseSchedulerConfig } from '../src/core/providers/coding-cli/scheduler/defaults.js';
import { emptyBandit, updateBandit } from '../src/core/providers/coding-cli/scheduler/learn.js';
import { deriveReading } from '../src/core/providers/coding-cli/scheduler/readings.js';
import { computeRegret } from '../src/core/providers/coding-cli/scheduler/regret.js';
import { schedule } from '../src/core/providers/coding-cli/scheduler/solve.js';
import { createPosthogSink } from '../src/core/providers/coding-cli/scheduler/telemetry.js';
import type { RouterOutcome } from '../src/core/providers/coding-cli/scheduler/types.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const config = embeddedSchedulerConfig();
const reading = (used: number, at: number) => deriveReading({
  poolId: 'grok-ultra-weekly', value: used, timestamp: new Date(at).toISOString(), source: 'manual',
}, NOW, config.horizon.staleAfterMs);
const outcome = (patch: Partial<RouterOutcome> = {}): RouterOutcome => ({
  ts: new Date(NOW).toISOString(), jobId: 'failed', jobType: 'coding', poolId: 'local', consumer: null,
  merged: false, green: false, reviewRounds: 1, reverted: false, tokens: null, wallMs: 1, cost: null, propensity: 1,
  ...patch,
});

describe('scheduler review regressions', () => {
  it.each([Date.parse('2026-10-20T00:00:00.000Z'), NOW + 1, Date.parse(config.grokUltraWeekly.usedFractionAsOf) - 1])('ignores out-of-window, future, or superseded manual usage at %s', async at => {
    const baseline = await schedule({ jobs: [], nowMs: NOW, config });
    const result = await schedule({ jobs: [], nowMs: NOW, config, manualReadings: [reading(0.99, at)] });
    expect(result.ultra).toEqual(baseline.ultra);
    expect(result.poolSeries).toEqual(baseline.poolSeries);
  });

  it('does not reopen a full concurrency pool after applying a manual reading', async () => {
    const result = await schedule({
      jobs: [{ id: 'orchestrate', jobType: 'orchestration' }], nowMs: NOW, config,
      manualReadings: [reading(0.1, NOW - 1_000)], inFlight: { 'grok-ultra-weekly': 1 },
    });
    expect(result.ultra.usedFraction).toBe(0.1);
    expect(result.assignments).toEqual([]);
    expect(result.unassigned).toEqual(['orchestrate']);
  });

  it('uses the latest valid manual balance and adds only subsequent shared consumer usage', async () => {
    const at = NOW - 7_200_000;
    const result = await schedule({
      jobs: [], nowMs: NOW, config,
      manualReadings: [reading(0.1, at - 1), reading(0.3, at), reading(0.99, NOW + 1)],
      events: [
        { ts: new Date(at - 1).toISOString(), consumer: 'orchestrator', fraction: 0.8 },
        { ts: new Date(at).toISOString(), consumer: 'cloud-agent', fraction: 0.7 },
        { ts: new Date(at + 1).toISOString(), consumer: 'orchestrator', fraction: 0.1 },
        { ts: new Date(at + 2).toISOString(), consumer: 'cloud-agent', fraction: 0.2 },
        { ts: new Date(NOW + 1).toISOString(), consumer: 'cloud-agent', fraction: 0.9 },
      ],
    });
    expect(result.ultra.unsplitUsedFraction).toBe(0.3);
    expect(result.ultra.orchestrator).toBe(0.1);
    expect(result.ultra.cloudAgent).toBe(0.2);
    expect(result.ultra.usedFraction).toBeCloseTo(0.6);
    expect(result.ultra.remaining).toBeCloseTo(0.4);
    expect(result.poolSeries.find(row => row.poolId === 'grok-ultra-weekly')).toMatchObject({
      readingSource: 'manual', actualCumulative: result.ultra.usedFraction, isReading: false,
    });
  });

  it('exhausts scheduling capacity when later usage consumes the manual balance', async () => {
    const at = NOW - 1_000;
    const result = await schedule({
      jobs: [{ id: 'orchestrate', jobType: 'orchestration' }], nowMs: NOW, config,
      manualReadings: [reading(0.9, at)],
      events: [{ ts: new Date(at + 1).toISOString(), consumer: 'cloud-agent', fraction: 0.1 }],
    });
    expect(result.ultra.remaining).toBe(0);
    expect(result.assignments).toEqual([]);
    expect(result.unassigned).toEqual(['orchestrate']);
  });

  it('does not report an unobserved prior as posterior regret', () => {
    const failed = outcome();
    expect(computeRegret({ outcomes: [failed], bandit: updateBandit(emptyBandit(), failed), config })).toEqual([]);
  });

  it.each(['coding', 'orchestration', 'merge-decision', 'review'] as const)('excludes role-ineligible observed arms for %s regret', jobType => {
    const failed = outcome({ jobType, poolId: 'grok-ultra-weekly', consumer: jobType === 'coding' ? 'cloud-agent' : 'orchestrator' });
    const impossible = outcome({
      jobType, poolId: jobType === 'orchestration' || jobType === 'merge-decision' ? 'codex-primary' : 'grok-ultra-weekly',
      consumer: jobType === 'coding' ? 'orchestrator' : jobType === 'review' ? 'cloud-agent' : null,
      merged: true, green: true, reviewRounds: 0,
    });
    const bandit = updateBandit(updateBandit(emptyBandit(), failed), impossible);
    expect(computeRegret({ outcomes: [failed], bandit, config })).toEqual([]);
  });

  it('reports a better observed producer instead of an ineligible orchestration arm', () => {
    const failed = outcome();
    let bandit = updateBandit(emptyBandit(), failed);
    bandit = updateBandit(bandit, outcome({ poolId: 'grok-ultra-weekly', consumer: 'orchestrator', merged: true, green: true, reviewRounds: 0 }));
    bandit = updateBandit(bandit, outcome({ poolId: 'codex-primary', merged: true, green: true, reviewRounds: 1 }));
    expect(computeRegret({ outcomes: [failed], bandit, config })).toEqual([
      expect.objectContaining({ chosenPool: 'local', betterPool: 'codex-primary', betterConsumer: null, regret: expect.any(Number) }),
    ]);
  });

  it.each(['http://us.i.posthog.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?key=x', 'https://example.com/#x'])('refuses unsafe PostHog host %s before sending', host => {
    const send = vi.fn();
    expect(() => createPosthogSink({ host, apiKey: 'fixture-capture-key', fetchImpl: send })).toThrow(/HTTPS origin/);
    expect(() => parseSchedulerConfig(JSON.stringify({ posthog: { host } }))).toThrow(/HTTPS origin/);
    expect(() => applyOverrides(config, { posthog: { host } })).toThrow(/HTTPS origin/);
    expect(send).not.toHaveBeenCalled();
  });

  it('captures to the configured HTTPS origin without following a redirect with the key', () => {
    const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const sink = createPosthogSink({ host: 'https://us.i.posthog.com/', apiKey: 'fixture-capture-key', fetchImpl: send });
    sink({ event: 'phantom_pool_burndown', timestamp: new Date(NOW).toISOString(), distinctId: 'fixture', properties: { used_fraction: 0.2 } });
    expect(send).toHaveBeenCalledWith('https://us.i.posthog.com/capture/', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    const body = JSON.parse(send.mock.calls[0]![1]!.body as string) as { api_key: string; properties: unknown };
    expect(body.api_key).toBe('fixture-capture-key');
    expect(body.properties).toEqual({ used_fraction: 0.2 });
  });
});
