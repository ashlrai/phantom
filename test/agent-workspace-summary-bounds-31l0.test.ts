import { describe, expect, it } from 'vitest';
import {
  summarizeAgentWorkspace,
  type AgentActionEvent,
} from '../src/core/fleet/agent-action-ledger.js';

const kinds: AgentActionEvent['kind'][] = [
  'tick', 'selection', 'route', 'dispatch', 'proposal', 'verification',
  'judge', 'merge', 'guard', 'maintenance', 'reflection',
];
const outcomes: AgentActionEvent['outcome'][] = [
  'started', 'ok', 'skipped', 'blocked', 'failed', 'proposal-created',
  'no-proposal', 'verified', 'judged', 'merged', 'rejected', 'unknown',
];
const backends: NonNullable<AgentActionEvent['backend']>[] = ['codex', 'claude'];

// Metadata only: distinct repos make the cap observable without any I/O.
const events: AgentActionEvent[] = Array.from({ length: 150 }, (_, index) => ({
  schemaVersion: 1,
  ts: '2026-07-08T12:00:00.000Z',
  actor: 'agent',
  kind: kinds[index % kinds.length]!,
  outcome: outcomes[index % outcomes.length]!,
  action: `action-${index}`,
  summary: 'synthetic metadata',
  repo: `/fake/repo-${index}`,
  backend: backends[index % backends.length]!,
}));

function expectFiniteNumbers(value: unknown): void {
  if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
  else if (Array.isArray(value)) value.forEach(expectFiniteNumbers);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(expectFiniteNumbers);
}

describe('agent workspace numeric presentation bounds', () => {
  it.each([Number.NaN, Infinity, -Infinity, -1, 0])('uses defaults for invalid input %s', (value) => {
    const summary = summarizeAgentWorkspace(events, {
      windowHours: value,
      limitPerDimension: value,
      recentLimit: value,
    });
    expect(summary.windowHours).toBe(24);
    expect(summary.byAction).toHaveLength(8);
    expect(summary.byOutcome).toHaveLength(8);
    expect(summary.byRepo).toHaveLength(8);
    expect(summary.recentActions).toHaveLength(10);
    expectFiniteNumbers(summary);
    expect(JSON.parse(JSON.stringify(summary)).windowHours).toBe(24);
  });

  it('keeps defaults and ordinary values, including the web caller recent limit', () => {
    const defaults = summarizeAgentWorkspace(events);
    expect(defaults.windowHours).toBe(24);
    expect(defaults.byRepo).toHaveLength(8);
    expect(defaults.recentActions).toHaveLength(10);

    const summary = summarizeAgentWorkspace(events, { windowHours: 48, limitPerDimension: 3, recentLimit: 20 });
    expect(summary.windowHours).toBe(48);
    expect(summary.byAction).toHaveLength(3);
    expect(summary.byOutcome).toHaveLength(3);
    expect(summary.byRepo).toHaveLength(3);
    expect(summary.byBackend).toHaveLength(2);
    expect(summary.recentActions).toHaveLength(20);
    expect(summary.recentActions.map((event) => event.action)).toEqual(events.slice(0, 20).map((event) => event.action));
  });

  it('floors positive fractions and keeps values below one positive', () => {
    const fractional = summarizeAgentWorkspace(events, { windowHours: 2.9, limitPerDimension: 3.9, recentLimit: 4.9 });
    expect(fractional.windowHours).toBe(2);
    expect(fractional.byRepo).toHaveLength(3);
    expect(fractional.recentActions).toHaveLength(4);

    const tiny = summarizeAgentWorkspace(events, { windowHours: 0.1, limitPerDimension: 0.1, recentLimit: 0.1 });
    expect(tiny.windowHours).toBe(1);
    expect(tiny.byRepo).toHaveLength(1);
    expect(tiny.recentActions).toHaveLength(1);
  });

  it('caps huge finite values and emits finite JSON with bounded arrays', () => {
    const summary = summarizeAgentWorkspace(events, {
      windowHours: Number.MAX_VALUE,
      limitPerDimension: Number.MAX_VALUE,
      recentLimit: Number.MAX_VALUE,
    });
    expect(summary.windowHours).toBe(8760);
    expect(summary.byRepo).toHaveLength(100);
    for (const rows of [summary.byAction, summary.byOutcome, summary.byRepo, summary.byBackend]) {
      expect(rows.length).toBeLessThanOrEqual(100);
    }
    expect(summary.recentActions).toHaveLength(100);
    expectFiniteNumbers(summary);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('normalizes each option independently', () => {
    const summary = summarizeAgentWorkspace(events, { windowHours: Infinity, limitPerDimension: 2, recentLimit: 3 });
    expect(summary.windowHours).toBe(24);
    expect(summary.byRepo).toHaveLength(2);
    expect(summary.recentActions).toHaveLength(3);
  });
});
