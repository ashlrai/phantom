import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { DropIngestedRow, JournalPass } from './leader-journal-model.js';
import { fateLine, jobFate, passFates } from './pass-fate-model.js';

const pass: JournalPass = { at: '2026-01-01T12:00:00Z', sections: [] };
const row = (id: string): DropIngestedRow => ({ at: pass.at, id, leader: 'fake', lane: 'main', tier: 'mid', title: '' });
const runs = (): FleetRuns => ({
  workers: [{ job: 'RQ-PHX-A', repo: 'fake', lane: 'main', tier: 'mid', ageSeconds: 20 }],
  publishesLastHour: [{ job: 'RQ-PHX-B', lane: 'main', url: null, at: pass.at }],
  mergesLastHour: { count: 1, items: [{ repo: 'fake', number: 2300, title: 'bridge: RQ-PHX-C (#2300)' }] },
  claimed: [{ job: 'RQ-PHX-D', lane: 'main', tier: 'mid', at: pass.at }],
} as FleetRuns);

describe('pass fates', () => {
  it('counts each job and formats the requested summary', () => {
    const result = passFates(pass, ['RQ-PHX-A', 'RQ-PHX-B', 'RQ-PHX-C'].map(row), runs());
    expect(result.chips).toEqual([
      { id: 'RQ-PHX-A', lane: 'main', state: 'running' },
      { id: 'RQ-PHX-B', lane: 'main', state: 'published' },
      { id: 'RQ-PHX-C', lane: 'main', state: 'merged' },
    ]);
    expect(fateLine(result.counts)).toBe('wrote 3 · running 1 · published 1 · merged 1');
    expect(fateLine(passFates(pass, [], runs()).counts)).toBe('wrote 0');
    expect(passFates(pass, [], runs()).chips).toEqual([]);
    expect(fateLine(passFates(pass, [row('RQ-PHX-D'), row('RQ-PHX-E')], runs()).counts)).toBe('wrote 2 · claimed 1 · waiting 1');
  });

  it('uses merged, published, running, claimed, waiting precedence', () => {
    const data = runs();
    const id = 'RQ-PHX-A';
    data.claimed!.push({ job: id, lane: 'main', tier: 'mid', at: pass.at });
    data.publishesLastHour.push({ job: id, lane: 'main', url: null, at: pass.at });
    data.mergesLastHour.items.push({ repo: 'fake', number: 1, title: `bridge: ${id}` });
    expect(jobFate(id, data)).toBe('merged');
    data.mergesLastHour.items.pop();
    expect(jobFate(id, data)).toBe('published');
    data.publishesLastHour.pop();
    expect(jobFate(id, data)).toBe('running');
    data.workers = [];
    expect(jobFate(id, data)).toBe('claimed');
    data.claimed = undefined;
    expect(jobFate(id, data)).toBe('waiting');
  });

  it('matches whole job IDs in merge titles, including punctuation in IDs', () => {
    const data = runs();
    expect(jobFate('RQ-PHX-C', data)).toBe('merged');
    data.mergesLastHour.items[0].title = 'bridge: RQ-PHX-C1 and prefix-RQ-PHX-C and RQ-PHX-C.extra';
    expect(jobFate('RQ-PHX-C', data)).toBe('waiting');
    data.mergesLastHour.items[0].title = 'bridge: RQ-PHX-C1, then RQ-PHX-C (#2300)';
    expect(jobFate('RQ-PHX-C', data)).toBe('merged');
  });
});
