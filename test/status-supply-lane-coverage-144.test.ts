import { describe, expect, it } from 'vitest';
import { summarizeStatusSupply, supplyLines } from '../src/core/comms/status-supply-line.js';
import { parseReadyTsv } from '../src/core/fleet/lane-console.js';
import type { PlannerHealth } from '../src/core/fleet/planner-failover.js';

const health: PlannerHealth = { status: 'unknown', lastGoodPassAt: null, failingSince: null, resetAt: null, reason: 'unavailable' };
const project = (rows: string, state: 'healthy' | 'missing' | 'degraded' = 'healthy') => {
  const parsed = parseReadyTsv(`id\tstatus\tpool\n${rows}`);
  expect(parsed.dropped).toBe(0);
  return supplyLines(summarizeStatusSupply(parsed.rows, health, state));
};

describe('status supply lane coverage', () => {
  it('reports a devin-flash-only ready queue', () => {
    expect(project('RQ-PHX-ONE\tREADY\tdevin-flash')[0]).toBe('Supply: devin-flash 1 phantom / 0 filler');
  });

  it('counts supported lanes in stable order and excludes parked, non-ready and arbitrary labels', () => {
    const lines = project([
      'FILL-GEM\tREADY\tgemini',
      'RQ-PHX-ZAI\tREADY\tzai',
      'RQ-PHX-OLD\tREADY\tcodex-personal',
      'FILL-FLASH\tREADY\tdevin-flash',
      'RQ-PHX-AGY\tREADY\tagy',
      'RQ-PHX-GROK\tREADY\tgrok',
      'RQ-PHX-CURSOR\tREADY\tcursor',
      'RQ-PHX-PARKED\tPARKED-BYHAND\tgemini',
      'RQ-PHX-PARKED2\tREADY\tPARKED-BYHAND.zai',
      'RQ-PHX-RUNNING\tRUNNING\tdevin-flash',
      'RQ-PHX-PRIVATE\tREADY\tprivate-label',
    ].join('\n'));
    expect(lines[0]).toBe('Supply: codex-personal 1 phantom / 0 filler; devin-flash 0 / 1; gemini 0 / 1; zai 1 / 0; agy 1 / 0; grok 1 / 0; cursor 1 / 0');
    expect(lines.join('\n')).not.toMatch(/private-label|PARKED|RQ-PHX/);
  });

  it.each(['degraded', 'missing'] as const)('keeps %s queue data unavailable', state => {
    expect(project('RQ-PHX-ONE\tREADY\tgemini', state)[0]).toBe('Supply: unavailable');
  });

  it('rejects injected labels, duplicate lanes, unsafe counts and planner text at the output boundary', () => {
    const result = summarizeStatusSupply(parseReadyTsv('READY\tRQ-PHX-ONE\tgemini').rows, health, 'healthy');
    result.lanes.push({ lane: 'private-label\nfree text', phxReady: 1, fillerReady: 0 });
    result.lanes.push({ lane: 'gemini', phxReady: 1, fillerReady: 0 });
    result.lanes.push({ lane: 'zai', phxReady: Number.MAX_SAFE_INTEGER + 1, fillerReady: 0 });
    result.planner.reason = 'private free text';
    expect(supplyLines(result)).toEqual(['Supply: none ready', 'Planner: unknown (unavailable)']);
  });
});
