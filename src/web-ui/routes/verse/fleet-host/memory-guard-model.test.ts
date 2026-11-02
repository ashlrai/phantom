import { describe, expect, it } from 'vitest';
import { memoryView } from '../../../../core/fleet/memory-view.js';
import { memoryGuardCard } from './memory-guard-model.js';

const NOW = 1793589510 * 1000;
const view = (memstat: unknown, memguard: unknown) => memoryView(memstat, memguard, NOW);

describe('memoryGuardCard', () => {
  it('returns null when the route is absent', () => {
    expect(memoryGuardCard(null)).toBeNull();
    expect(memoryGuardCard(undefined)).toBeNull();
  });

  it('reports unknown fields as unknown, never 0', () => {
    const card = memoryGuardCard(view(null, null))!;
    expect(card.tone).toBe('neutral');
    expect(card.lines).toEqual([
      'Memory free unknown · disk free unknown',
      'Swap unknown · unknown swapouts/min',
      'oMLX unknown',
      'Guard calm unknown',
    ]);
    expect(card.stoppedJobs).toBeNull();
    expect(card.staleText).toBeNull();
  });

  it('is ok for a fresh, calm guard', () => {
    const card = memoryGuardCard(view(
      { ts: NOW / 1000 - 30, free_pct: 58, swap_gb: 0, swapouts_per_min: 0, disk_gb: 601 },
      { stopped: {}, calm: 8, omlx_down: false },
    ))!;
    expect(card.tone).toBe('ok');
    expect(card.lines).toEqual([
      'Memory free 58% · disk free 601 GB',
      'Swap 0 GB · 0 swapouts/min',
      'oMLX loaded',
      'Guard calm 8',
    ]);
    expect(card.stoppedJobs).toBeNull();
    expect(card.staleText).toBeNull();
  });

  it('warns and names the sample age once the sample is stale', () => {
    const card = memoryGuardCard(view({ ts: (NOW - 10 * 60_000) / 1000, free_pct: 58 }, { stopped: {} }))!;
    expect(card.tone).toBe('warn');
    expect(card.staleText).toBe('Memory sample is 10 min old. The guard may not be running.');
  });

  it('warns and lists the stopped workers when the guard holds jobs', () => {
    const card = memoryGuardCard(view(
      { ts: NOW / 1000 - 30, free_pct: 58 },
      { stopped: { '4242': 'RQ-PHX-A', '4243': 'RQ-PHX-B' }, omlx_down: true },
    ))!;
    expect(card.tone).toBe('warn');
    expect(card.stoppedJobs).toEqual(['RQ-PHX-A', 'RQ-PHX-B']);
    expect(card.lines).toContain('oMLX unloaded');
    expect(card.staleText).toBeNull();
  });
});
