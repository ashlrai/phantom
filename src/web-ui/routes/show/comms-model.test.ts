import { describe, expect, it } from 'vitest';
import type { AgentWorkspaceRecentAction, RunState } from '../../data/api-types.js';
import { buildCommsThreads, outcomeTone } from './comms-model.js';

function action(overrides: Partial<AgentWorkspaceRecentAction> = {}): AgentWorkspaceRecentAction {
  return {
    ts: '2026-11-10T12:00:00Z',
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'started',
    action: 'dispatch',
    summary: 'dispatched a job',
    ...overrides,
  };
}

describe('buildCommsThreads', () => {
  it('groups actions by run and titles the thread with the run goal', () => {
    const runs = [{ id: 'r1', goal: 'ship the feature' } as RunState];
    const threads = buildCommsThreads(
      [
        action({ runId: 'r1', ts: '2026-11-10T12:02:00Z', summary: 'second beat', outcome: 'ok' }),
        action({ runId: 'r1', ts: '2026-11-10T12:01:00Z', summary: 'first beat' }),
      ],
      runs,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]!.title).toBe('ship the feature');
    expect(threads[0]!.href).toBe('/work/runs/r1');
    // Chronological inside the thread: oldest first.
    expect(threads[0]!.messages.map((m) => m.summary)).toEqual(['first beat', 'second beat']);
  });

  it('keeps run, proposal, trajectory and actor threads distinct', () => {
    const threads = buildCommsThreads(
      [
        action({ runId: 'r9' }),
        action({ runId: undefined, proposalId: 'p2' }),
        action({ runId: undefined, proposalId: undefined, trajectoryId: 't-abc' }),
        action({ runId: undefined, proposalId: undefined, trajectoryId: undefined, actor: 'judge', kind: 'judge' }),
      ],
      [],
    );
    expect(threads.map((t) => t.key)).toEqual(['run:r9', 'proposal:p2', 'trajectory:t-abc', 'actor:judge']);
    expect(threads[1]!.href).toBe('/inbox/p2');
    expect(threads[2]!.href).toBeNull();
    expect(threads[3]!.title).toBe('Judge');
  });

  it('labels kinds readably and tones outcomes', () => {
    const threads = buildCommsThreads(
      [action({ kind: 'verification', outcome: 'verified', actor: 'verifier' })],
      [],
    );
    const msg = threads[0]!.messages[0]!;
    expect(msg.kindLabel).toBe('Verified');
    expect(msg.tone).toBe('good');
    expect(outcomeTone('failed')).toBe('bad');
    expect(outcomeTone('started')).toBe('live');
    expect(outcomeTone('skipped')).toBe('muted');
  });

  it('caps messages per thread and counts the hidden remainder', () => {
    const threads = buildCommsThreads(
      // recentActions arrive newest-first; the thread keeps the newest two, chronological.
      [4, 3, 2, 1].map((n) => action({ runId: 'r1', ts: `2026-11-10T12:0${n}:00Z`, summary: `beat ${n}` })),
      [],
      5,
      2,
    );
    expect(threads[0]!.messages.map((m) => m.summary)).toEqual(['beat 3', 'beat 4']);
    expect(threads[0]!.hiddenCount).toBe(2);
  });

  it('handles empty and missing input without inventing threads', () => {
    expect(buildCommsThreads(undefined, undefined)).toEqual([]);
    expect(buildCommsThreads([], [])).toEqual([]);
  });
});
