import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleObserve, parseRoster, pipelineLabel, sessionFromRoster } from '../src/core/observe/assemble.js';
import { parseBottlenecks, parseHumanSteps } from '../src/core/observe/contracts.js';
import { headlinesFor, parsePullExport } from '../src/core/observe/pulls.js';
import { classifyResources, resourceCounts } from '../src/core/observe/resources.js';
import { projectSensors } from '../src/core/observe/sensors.js';
import { cmdObserve } from '../src/cli/observe.js';
import { mergeDesktopRoster } from '../src/core/observe/read.js';
import type { AgentRoster } from '../src/core/fleet/agent-roster.js';
import { applySensorHeadroom } from '../src/web-ui/routes/verse/resources/sensor-headroom.js';
import type { BusWorkClaimView } from '../src/core/fleet/bus-work-claims.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function claim(partial: Partial<BusWorkClaimView> & Pick<BusWorkClaimView, 'id' | 'owner'>): BusWorkClaimView {
  return { cursor: 1, receivedAt: NOW - 60_000, leaseUntil: NOW + 60_000, completedAt: null, ...partial };
}

function roster(sources: { source: string; availability: 'known' | 'unknown'; sessions?: { sessionId: string; title?: string | null; ownership?: string | null; claims?: { id: string }[] }[] }[]) {
  return {
    schema: 'agent-roster.v1',
    sources: sources.map((source) => ({
      source: source.source,
      availability: source.availability,
      sessions: (source.sessions ?? []).map((session) => ({
        provider: source.source,
        sessionId: session.sessionId,
        title: session.title ?? null,
        state: 'running',
        ownership: session.ownership ?? null,
        claims: session.claims ?? [],
        lastActivity: new Date(NOW - 30_000).toISOString(),
      })),
    })),
  };
}

describe('usage sensors', () => {
  it('keeps a stale reading from counting as headroom', () => {
    const [lane] = projectSensors({
      schema: 'usage.sensors.v1',
      readings: [{
        lane: 'devin', observedAt: new Date(NOW - 3_600_000).toISOString(), source: 'devin-api-v3-daily',
        staleAfter: new Date(NOW - 60_000).toISOString(), used: 0, limit: 100, unit: 'acu', resetAt: null,
      }],
    }, NOW);
    expect(lane?.status).toBe('unknown');
    expect(lane?.headroom).toBeNull();
    expect(lane?.used).toBeNull();
  });

  it('reports fresh headroom and an unused-before-reset alert from two readings', () => {
    const [lane] = projectSensors({
      readings: [{
        lane: 'claude-max', observedAt: new Date(NOW).toISOString(), source: 'claude-usage',
        staleAfter: new Date(NOW + 60_000).toISOString(), used: 10, limit: 100, unit: 'percent',
        resetAt: new Date(NOW + 3_600_000).toISOString(), priorUsed: 0, priorObservedAt: new Date(NOW - 3_600_000).toISOString(),
      }],
    }, NOW);
    expect(lane?.headroom).toBe(90);
    expect(lane?.burnPerHour).toBe(10);
    expect(lane?.alert).toBe('unused-before-reset');
  });
});

describe('resource coordination', () => {
  it('does not count an unreachable resource as idle', () => {
    const { items } = classifyResources({
      roster: parseRoster(roster([{ source: 'claude', availability: 'unknown' }, { source: 'phantom', availability: 'known' }]))!.sources,
      claims: { source: 'missing', claims: [] },
      windows: projectSensors({ readings: [{ lane: 'claude-max', observedAt: new Date(NOW).toISOString(), source: 'claude-usage', staleAfter: new Date(NOW + 60_000).toISOString(), used: 1, limit: 10, unit: 'percent', resetAt: null }] }, NOW),
      nowMs: NOW, windowMs: 15 * 60_000,
    });
    const claude = items.find((item) => item.id === 'claude');
    expect(claude?.state).toBe('unknown');
    expect(resourceCounts(items).idle).toBeNull();
  });

  it('marks a reachable claimed lane coordinated and a headroom lane idle', () => {
    const parsed = parseRoster(roster([
      { source: 'phantom', availability: 'known', sessions: [{ sessionId: 'job-1', ownership: 'codex-personal', title: 'ship observe' }] },
      { source: 'claude', availability: 'known', sessions: [{ sessionId: 'claude-1', title: 'notes' }] },
    ]))!;
    const { items } = classifyResources({
      roster: parsed.sources,
      claims: { source: 'available', claims: [claim({ id: 'job-1', owner: 'codex-personal' })] },
      windows: projectSensors({ readings: [
        { lane: 'codex-personal', observedAt: new Date(NOW).toISOString(), source: 'codex-app-server', staleAfter: new Date(NOW + 60_000).toISOString(), used: 1, limit: 10, unit: 'percent', resetAt: null },
        { lane: 'claude-max', observedAt: new Date(NOW).toISOString(), source: 'claude-usage', staleAfter: new Date(NOW + 60_000).toISOString(), used: 1, limit: 10, unit: 'percent', resetAt: null },
      ] }, NOW),
      nowMs: NOW, windowMs: 15 * 60_000,
    });
    expect(items.find((item) => item.id === 'codex-personal')?.state).toBe('coordinated');
    expect(items.find((item) => item.id === 'claude')?.state).toBe('idle');
    expect(items.find((item) => item.id === 'dot')?.state).toBe('unknown');
    const counts = resourceCounts(items);
    expect(counts).toMatchObject({ coordinated: 1, idle: 1, duplicated: 0 });
    expect(counts.idle).not.toBe(counts.unknown);
  });

  it('marks two sessions on one task duplicated', () => {
    const parsed = parseRoster(roster([
      { source: 'claude', availability: 'known', sessions: [{ sessionId: 'a', title: 'same task' }, { sessionId: 'b', title: 'same task' }] },
    ]))!;
    const { items } = classifyResources({
      roster: parsed.sources,
      claims: { source: 'missing', claims: [] },
      windows: [],
      nowMs: NOW, windowMs: 15 * 60_000,
    });
    expect(items.find((item) => item.id === 'claude')?.state).toBe('duplicated');
  });

  it('does not call a reachable resource idle when claims cannot be read', () => {
    const parsed = parseRoster(roster([{ source: 'claude', availability: 'known', sessions: [] }]))!;
    const { items } = classifyResources({
      roster: parsed.sources,
      claims: { source: 'unavailable', claims: [] },
      windows: projectSensors({ readings: [{ lane: 'claude-max', observedAt: new Date(NOW).toISOString(), source: 'claude-usage', staleAfter: new Date(NOW + 60_000).toISOString(), used: 0, limit: 10, unit: 'percent', resetAt: null }] }, NOW),
      nowMs: NOW, windowMs: 15 * 60_000,
    });
    expect(items.find((item) => item.id === 'claude')?.state).toBe('unknown');
  });
});

describe('contracts and headlines', () => {
  it('reads human steps and keeps a missing file unknown', () => {
    expect(parseHumanSteps(null).stepsRemaining).toBeNull();
    const parsed = parseHumanSteps({
      schema: 'ashlr.human-steps/v1', generatedAt: new Date(NOW).toISOString(), source: 'eng-ops', stepsRemaining: 0,
      decisions: [{ id: 'd1', at: new Date(NOW).toISOString(), kind: 'approval', title: 'Ship it', actor: 'eng-ops', status: 'pending' }],
    });
    expect(parsed.stepsRemaining).toBe(0);
    expect(parsed.decisions).toHaveLength(1);
  });

  it('keeps bottleneck file order and drops unmeasured rows', () => {
    const parsed = parseBottlenecks({
      schema: 'bottlenecks.v1',
      items: [
        { id: 'ci', metric: 'ci_minutes', value: 40, unit: 'minutes_per_pr', owner: 'ci', before: null, after: null, verifiedAt: null },
        { id: 'nope', metric: 'not-a-metric', value: 1, unit: 'x', owner: 'x' },
        { id: 'queue', metric: 'merge_queue_wait', value: 12, unit: 'minutes', owner: 'merge', before: 30, after: 12, verifiedAt: new Date(NOW).toISOString() },
      ],
    });
    expect(parsed.top.map((item) => item.id)).toEqual(['ci', 'queue']);
    expect(parsed.top[0]?.before).toBeNull();
  });

  it('computes merged per day and leaves change-failure unknown without labels', () => {
    const parsed = parsePullExport({
      complete: true,
      pulls: [
        { repo: 'acme/app', number: 1, state: 'merged', createdAt: new Date(NOW - 86_400_000).toISOString(), mergedAt: new Date(NOW - 3_600_000).toISOString() },
        { repo: 'acme/app', number: 2, state: 'closed', createdAt: new Date(NOW - 86_400_000).toISOString(), closedAt: new Date(NOW - 1_000).toISOString() },
      ],
    });
    const [repo] = headlinesFor(parsed!.pulls, NOW, 7, true);
    expect(repo?.mergedPerDay).toBeCloseTo(1 / 7);
    expect(repo?.failed).toBe(1);
    expect(repo?.changeFailureRate).toBeNull();
    expect(repo?.queueWaitHours).toBeNull();
  });

  it('divides reverts, fix-forward pulls, and failed releases by merges', () => {
    const pulls = parsePullExport([
      { repo: 'acme/app', number: 1, state: 'merged', createdAt: new Date(NOW - 3_600_000).toISOString(), mergedAt: new Date(NOW - 1_000).toISOString(), reverted: true, fixForward: false, failedRelease: false },
      { repo: 'acme/app', number: 2, state: 'merged', createdAt: new Date(NOW - 3_600_000).toISOString(), mergedAt: new Date(NOW - 1_000).toISOString(), reverted: false, fixForward: false, failedRelease: false },
    ])!.pulls;
    expect(headlinesFor(pulls, NOW, 7, true)[0]?.changeFailureRate).toBeCloseTo(0.5);
    expect(headlinesFor(pulls, NOW, 7, false)[0]?.state).toBe('unknown');
  });
});

describe('assemble and cli', () => {
  it('builds one snapshot with null coordination counts when the roster is absent', () => {
    const snapshot = assembleObserve({ nowMs: NOW, updatePhase: 'failed' });
    expect(snapshot.schema).toBe('observe.human.v1');
    expect(snapshot.resources.counts).toEqual({ coordinated: null, idle: null, duplicated: null, unknown: 8 });
    expect(snapshot.graph.bottleneck).toEqual({ nodeId: 'update_check', reason: 'Update check failed' });
    expect(pipelineLabel('failed')).toBe('Release pipeline: Update check failed');
    expect(snapshot.humans.stepsRemaining).toBeNull();
    expect(snapshot.coverage.fields.unknown).toBeGreaterThan(0);
  });

  it('returns an unknown transcript for a known session', () => {
    const detail = sessionFromRoster(roster([{ source: 'claude', availability: 'known', sessions: [{ sessionId: 'claude-9', title: 'notes' }] }]), 'claude-9', NOW);
    expect(detail.state).toBe('live');
    expect(detail.transcript).toBeNull();
  });

  const logs: string[] = [];
  afterEach(() => { logs.length = 0; vi.restoreAllMocks(); });

  it('prints json from a human-steps file and refuses a bad flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observe-'));
    const file = join(dir, 'human-steps.json');
    writeFileSync(file, JSON.stringify({ schema: 'ashlr.human-steps/v1', generatedAt: new Date(NOW).toISOString(), source: 'eng-ops', stepsRemaining: 3, decisions: [] }));
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    expect(await cmdObserve(['--json', '--human-steps', file, '--claim-minutes', '15'])).toBe(0);
    const body = JSON.parse(logs.at(-1) ?? '{}') as { humans: { stepsRemaining: number } };
    expect(body.humans.stepsRemaining).toBe(3);
    expect(await cmdObserve(['--nope'])).toBe(2);
  });
});

describe('desktop sessions', () => {
  const base = (): AgentRoster => ({
    schema: 'agent-roster.v1',
    observedAt: new Date(NOW).toISOString(),
    latencyMs: 0,
    sources: [
      { source: 'devin-desktop', ok: false, availability: 'unknown', sessions: [], error: 'no export', observedAt: new Date(NOW).toISOString(), truncated: false },
      { source: 'cursor', ok: false, availability: 'unknown', sessions: [], error: 'interactive', observedAt: new Date(NOW).toISOString(), truncated: false },
      { source: 'grok', ok: false, availability: 'unknown', sessions: [], error: 'human table', observedAt: new Date(NOW).toISOString(), truncated: false },
    ],
    sessions: [],
    claims: { source: 'missing', items: [] },
  });

  it('keeps Devin desktop, Cursor, and Grok unknown when the operator is not readable', () => {
    const merged = mergeDesktopRoster(base(), { ok: false, code: 'unsupported', error: 'Desktop operator runs on macOS.', sessions: [] });
    expect(merged.sources.every((source) => source.availability === 'unknown')).toBe(true);
    expect(merged.sessions).toHaveLength(0);
  });

  it('records a visible Cursor window and leaves the other two unknown', () => {
    const merged = mergeDesktopRoster(base(), {
      ok: true,
      sessions: [{ app: 'Cursor', bundleId: null, windowTitle: 'phantom', sessionTitle: 'phantom', lastActivity: null, rosterApp: 'cursor' }],
    });
    expect(merged.sources.find((source) => source.source === 'cursor')?.availability).toBe('known');
    expect(merged.sources.find((source) => source.source === 'grok')?.availability).toBe('unknown');
    expect(merged.sources.find((source) => source.source === 'devin-desktop')?.availability).toBe('unknown');
    expect(merged.sessions.map((session) => session.provider)).toEqual(['cursor']);
  });
});

describe('sensor headroom on the resource bar', () => {
  it('replaces a stale percent when headroom is null', () => {
    const [row] = applySensorHeadroom([
      { engine: 'devin', name: 'Devin (cloud)', leftPercent: 80, level: 'ok', value: '0 ACUs reported', summary: 'current' },
    ], [{ lane: 'devin', status: 'unknown', headroom: null, used: null, limit: null, unit: null, resetAt: null, observedAt: null, source: null, staleAfter: null, burnPerHour: null, projectedUnused: null, alert: null }]);
    expect(row?.value).toBe('unknown');
    expect(row?.leftPercent).toBeNull();
  });
});
