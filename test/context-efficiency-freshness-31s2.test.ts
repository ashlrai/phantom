import { describe, expect, it } from 'vitest';
import { buildContextEfficiencyStatus, type FleetContextEfficiencyInput } from '../src/core/fleet/context-efficiency.js';
import type { GenomeHealth } from '../src/core/types.js';

const now = '2026-10-31T12:00:00.000Z';
const windowMs = 24 * 60 * 60 * 1000;
const genome: GenomeHealth = {
  totalEntries: 3,
  projects: 1,
  hubEntries: 3,
  sizeBytes: 100,
  lastLearnedAt: now,
  embeddingsAvailable: false,
};

describe('context efficiency memory freshness', () => {
  it.each([
    ['null', null],
    ['malformed', 'not-a-date'],
    ['future by one millisecond', '2026-10-31T12:00:00.001Z'],
    ['future by one day', '2026-11-01T12:00:00.000Z'],
  ])('reports unknown freshness for a %s memory timestamp', (_label, lastLearnedAt) => {
    const status = buildContextEfficiencyStatus({}, { ...genome, lastLearnedAt }, now, windowMs);
    expect(status.signals).toMatchObject({ lastMemoryAt: lastLearnedAt, memoryAgeHours: null, retrievalPosture: 'unknown' });
    expect(status.risks.some((risk) => risk.id === 'memory-stale')).toBe(false);
  });

  it('reports unknown freshness when the memory timestamp is absent', () => {
    const { lastLearnedAt: _lastLearnedAt, ...withoutTimestamp } = genome;
    const status = buildContextEfficiencyStatus({}, withoutTimestamp as GenomeHealth, now, windowMs);
    expect(status.signals).toMatchObject({ lastMemoryAt: null, memoryAgeHours: null, retrievalPosture: 'unknown' });
  });

  it('reports unknown freshness when the observation timestamp is invalid', () => {
    const status = buildContextEfficiencyStatus({}, genome, 'not-a-date', windowMs);
    expect(status.signals).toMatchObject({ lastMemoryAt: now, memoryAgeHours: null, retrievalPosture: 'unknown' });
  });

  it.each([
    ['exactly now', now, 0, 'available'],
    ['one day ago', '2026-10-30T12:00:00.000Z', 24, 'available'],
    ['exactly seven days ago', '2026-10-24T12:00:00.000Z', 168, 'available'],
    ['more than seven days ago', '2026-10-24T11:54:00.000Z', 168.1, 'stale'],
  ] as const)('preserves freshness for %s', (_label, lastLearnedAt, age, posture) => {
    const status = buildContextEfficiencyStatus({}, { ...genome, lastLearnedAt }, now, windowMs);
    expect(status.signals).toMatchObject({ lastMemoryAt: lastLearnedAt, memoryAgeHours: age, retrievalPosture: posture });
    expect(status.risks.some((risk) => risk.id === 'memory-stale')).toBe(posture === 'stale');
  });

  it('preserves empty and absent genome semantics even with an invalid observation date', () => {
    const empty = buildContextEfficiencyStatus({}, { ...genome, totalEntries: 0, lastLearnedAt: null }, 'invalid', windowMs);
    const absent = buildContextEfficiencyStatus({}, undefined, 'invalid', windowMs);
    expect(empty.signals).toMatchObject({ memoryEntries: 0, lastMemoryAt: null, memoryAgeHours: null, retrievalPosture: 'empty' });
    expect(empty.risks.some((risk) => risk.id === 'memory-empty')).toBe(true);
    expect(absent.signals).toMatchObject({ memoryEntries: 0, lastMemoryAt: null, memoryAgeHours: null, retrievalPosture: 'unknown' });
    expect(absent.risks.some((risk) => risk.id === 'memory-unavailable')).toBe(true);
  });

  it('does not mutate its input objects', () => {
    const input: FleetContextEfficiencyInput = {
      proposalProduction: { proposalsCreated: 2, diagnosticNoProposalDispatches: 1, suppressedDispatches: 0 },
      queue: { repos: { withBacklog: 2 } },
    };
    const memory = { ...genome, lastLearnedAt: '2026-11-01T12:00:00.000Z' };
    const beforeInput = structuredClone(input);
    const beforeMemory = structuredClone(memory);
    buildContextEfficiencyStatus(input, memory, now, windowMs);
    expect(input).toEqual(beforeInput);
    expect(memory).toEqual(beforeMemory);
  });
});
