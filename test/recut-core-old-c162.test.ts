/** Recut of PR #3509 (RQ-PHX-COSLOOPVERB12) — runCosLoop's per-pass observer
 * receives one event per completed pass, carrying the job id only when the
 * pass named one; a throwing pass surfaces as outcome 'error'. */
import { describe, expect, it } from 'vitest';
import { runCosLoop, type CosLoopPassEvent } from '../src/core/cos/loop.js';
import type { CosWorkResult } from '../src/core/cos/worker.js';

describe('recut core old c162: runCosLoop onPass events', () => {
  it('emits one ordered event per pass with ids on named outcomes only', async () => {
    let t = 0;
    const seq: CosWorkResult[] = [
      { outcome: 'drafted', id: 'cos-1', provider: 'fake' },
      { outcome: 'idle' },
      { outcome: 'blocked', id: 'cos-2', reason: 'slate-empty' },
    ];
    let i = 0;
    const events: CosLoopPassEvent[] = [];
    const summary = await runCosLoop({
      durationMs: 60_000,
      intervalMs: 5_000,
      maxPasses: 3,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
      work: async () => seq[i++] ?? { outcome: 'idle' },
      onPass: (event) => { events.push(event); },
    });
    expect(events).toEqual([
      { pass: 1, outcome: 'drafted', id: 'cos-1' },
      { pass: 2, outcome: 'idle' },
      { pass: 3, outcome: 'blocked', id: 'cos-2' },
    ]);
    expect(summary).toMatchObject({ passes: 3, termination: 'max-passes', lastBlockedReason: 'slate-empty' });
  });
});
