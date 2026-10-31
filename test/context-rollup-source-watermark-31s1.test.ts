import { describe, expect, it } from 'vitest';

import type { AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import {
  CONTEXT_ROLLUP_ACTION,
  CONTEXT_ROLLUP_SUMMARY,
  decideContextRollup,
  type ContextRollupDecision,
  type ContextRollupOptions,
} from '../src/core/fleet/context-rollup.js';

const OBSERVED = '2026-07-11T16:05:00.000Z';
const HOUR_MS = 60 * 60 * 1_000;
const options: ContextRollupOptions = {
  defaultContract: { cadenceMs: 6 * HOUR_MS, minimumTerminalTrajectories: 10 },
};

function rollupRecord(
  emittedAt: string,
  sourceMaxAt: string,
  idChar = 'a',
  overrides: Partial<AgentActionEvent> = {},
): AgentActionEvent {
  return {
    schemaVersion: 1,
    ts: emittedAt,
    actor: 'daemon',
    kind: 'context-rollup',
    outcome: 'ok',
    action: CONTEXT_ROLLUP_ACTION,
    summary: CONTEXT_ROLLUP_SUMMARY,
    contextRollupId: `cr-${idChar.repeat(64)}`,
    contextRollupPolicyVersion: 'context-rollup-v1',
    contextRollupSourceMaxTs: sourceMaxAt,
    ...overrides,
  };
}

function decide(
  persistedRollupEvents: unknown,
  latestSourceAt: string,
  observedAt = OBSERVED,
): ContextRollupDecision {
  return decideContextRollup({
    observedAt,
    eligibleEventCount: 12,
    latestSourceAt,
    persistedRollupEvents,
  }, options);
}

describe('RQ-PHX-ROLLUPWATERMARK31S1 context-rollup source watermark', () => {
  it('emits late-arriving evidence stamped between the prior watermark and its publication', () => {
    // Prior rollup covered sources up to 10:00 and was published at 10:05.
    // Evidence stamped 10:03 arrived after the watermark; comparing it to the
    // 10:05 publication timestamp would suppress it, so the persisted source
    // watermark must govern instead.
    const previous = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T10:00:00.000Z');
    expect(decide([previous], '2026-07-11T10:03:00.000Z')).toMatchObject({
      disposition: 'emit',
      latestRollupAt: '2026-07-11T10:05:00.000Z',
      event: {
        ts: OBSERVED,
        contextRollupSourceMaxTs: '2026-07-11T10:03:00.000Z',
        reason: 'cadence-and-new-evidence',
      },
    });
  });

  it('keeps unchanged or older source evidence as no-new-evidence after cadence', () => {
    const previous = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T10:00:00.000Z');
    for (const latestSourceAt of ['2026-07-11T10:00:00.000Z', '2026-07-11T09:59:00.000Z']) {
      expect(decide([previous], latestSourceAt)).toEqual({
        disposition: 'noop',
        reason: 'no-new-evidence',
      });
    }
    // One millisecond past the watermark is new evidence.
    expect(decide([previous], '2026-07-11T10:00:00.001Z')).toMatchObject({
      disposition: 'emit',
    });
  });

  it('measures cadence from the latest publication emission time, not its watermark', () => {
    const previous = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T10:00:00.000Z');
    // 6h after the 10:00 watermark but only 5h55m after the 10:05 publication.
    expect(decide([previous], '2026-07-11T11:30:00.000Z', '2026-07-11T16:00:00.000Z')).toEqual({
      disposition: 'noop',
      reason: 'cadence-active',
    });
    // One millisecond before cadence expiry still suppresses new evidence.
    expect(decide([previous], '2026-07-11T11:30:00.000Z', '2026-07-11T16:04:59.999Z')).toEqual({
      disposition: 'noop',
      reason: 'cadence-active',
    });
  });

  it('selects the newest publication deterministically regardless of persisted order', () => {
    const newest = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T10:00:00.000Z', 'a');
    const older = rollupRecord('2026-07-11T09:00:00.000Z', '2026-07-11T08:00:00.000Z', 'b');
    const orders = [[newest, older], [older, newest]];
    for (const persistedRollupEvents of orders) {
      expect(decide(persistedRollupEvents, '2026-07-11T10:03:00.000Z')).toMatchObject({
        disposition: 'emit',
        latestRollupAt: '2026-07-11T10:05:00.000Z',
      });
    }
    // Evidence inside the newest watermark stays suppressed in both orders even
    // though it is newer than the older record's watermark.
    for (const persistedRollupEvents of orders) {
      expect(decide(persistedRollupEvents, '2026-07-11T09:30:00.000Z')).toEqual({
        disposition: 'noop',
        reason: 'no-new-evidence',
      });
    }
  });

  it('does not adopt an older publication\'s larger watermark as the latest publication', () => {
    // The newest publication regressed its watermark below an older record's.
    // Only the newest publication's watermark governs, so the uncovered
    // interval emits and republishes the true watermark.
    const newest = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T08:00:00.000Z', 'a');
    const older = rollupRecord('2026-07-11T09:00:00.000Z', '2026-07-11T09:00:00.000Z', 'b');
    for (const persistedRollupEvents of [[newest, older], [older, newest]]) {
      expect(decide(persistedRollupEvents, '2026-07-11T08:30:00.000Z')).toMatchObject({
        disposition: 'emit',
        latestRollupAt: '2026-07-11T10:05:00.000Z',
      });
    }
  });

  it('uses the maximum source watermark among records sharing the newest emission time', () => {
    const low = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T10:00:00.000Z', 'a');
    const high = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T10:04:00.000Z', 'b');
    // 10:03 exceeds the low watermark but not the shared-emission maximum.
    for (const persistedRollupEvents of [[low, high], [high, low]]) {
      expect(decide(persistedRollupEvents, '2026-07-11T10:03:00.000Z')).toEqual({
        disposition: 'noop',
        reason: 'no-new-evidence',
      });
    }
    // Past the shared-emission maximum watermark but before its publication ts.
    for (const persistedRollupEvents of [[low, high], [high, low]]) {
      expect(decide(persistedRollupEvents, '2026-07-11T10:04:30.000Z')).toMatchObject({
        disposition: 'emit',
      });
    }
  });

  it('fails closed on malformed or future persisted source timestamps', () => {
    const emitted = '2026-07-11T10:05:00.000Z';
    const missingWatermark = { ...rollupRecord(emitted, emitted, 'a') };
    delete missingWatermark.contextRollupSourceMaxTs;
    const malformedRows: unknown[] = [
      missingWatermark,
      rollupRecord(emitted, emitted, 'a', { contextRollupSourceMaxTs: undefined }),
      rollupRecord(emitted, emitted, 'a', { contextRollupSourceMaxTs: 1_720_000_000_000 as never }),
      rollupRecord(emitted, emitted, 'a', { contextRollupSourceMaxTs: 'not-a-timestamp' }),
      rollupRecord(emitted, emitted, 'a', { contextRollupSourceMaxTs: '2026-13-40T99:99:99.999Z' }),
      rollupRecord(emitted, emitted, 'a', { contextRollupSourceMaxTs: '2026-07-11T10:00:00.000+00:00' }),
      rollupRecord(emitted, emitted, 'a', { contextRollupSourceMaxTs: '2026-07-11T10:00:00Z' }),
      // Watermark after its own publication.
      rollupRecord(emitted, '2026-07-11T11:00:00.000Z', 'a'),
      // Publication in the future relative to the observation.
      rollupRecord('2026-07-11T17:00:00.000Z', '2026-07-11T16:00:00.000Z', 'a'),
    ];
    for (const row of malformedRows) {
      expect(decide([row], '2026-07-11T11:00:00.000Z')).toEqual({
        disposition: 'noop',
        reason: 'malformed-input',
      });
    }
    // A malformed row anywhere in the array poisons the whole input.
    const good = rollupRecord(emitted, '2026-07-11T10:00:00.000Z', 'b');
    expect(decide([good, malformedRows[3]], '2026-07-11T11:00:00.000Z')).toEqual({
      disposition: 'noop',
      reason: 'malformed-input',
    });
    // Source evidence newer than the observation is malformed.
    expect(decide([good], '2026-07-11T17:00:00.000Z')).toEqual({
      disposition: 'noop',
      reason: 'malformed-input',
    });
  });

  it('still emits a metadata-only event with a deterministic id', () => {
    const previous = rollupRecord('2026-07-11T10:05:00.000Z', '2026-07-11T10:00:00.000Z');
    const input = {
      observedAt: OBSERVED,
      eligibleEventCount: 12,
      latestSourceAt: '2026-07-11T10:03:00.000Z',
      persistedRollupEvents: [previous],
      counts: { proposalCreated: 2 },
    };
    const first = decideContextRollup(input, options);
    const second = decideContextRollup(input, options);
    expect(first.disposition).toBe('emit');
    expect(second.disposition).toBe('emit');
    if (first.disposition !== 'emit' || second.disposition !== 'emit') return;
    expect(second.event.contextRollupId).toBe(first.event.contextRollupId);
    expect(first.event.contextRollupId).toMatch(/^cr-[0-9a-f]{64}$/);
    expect(first.event).toMatchObject({
      ts: OBSERVED,
      actor: 'daemon',
      kind: 'context-rollup',
      outcome: 'ok',
      action: CONTEXT_ROLLUP_ACTION,
      summary: CONTEXT_ROLLUP_SUMMARY,
      contextRollupPolicyVersion: 'context-rollup-v1',
      contextRollupSourceMaxTs: '2026-07-11T10:03:00.000Z',
    });
    expect(JSON.stringify(first.event)).not.toMatch(/repo|prompt|secret/i);
  });
});
