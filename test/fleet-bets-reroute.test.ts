import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBets, formatBets, readBets } from '../src/cli/fleet-bets.js';

const vision = `# Leader bets
- READY RQ-OWN (P1, pool=codex-personal, tier=work): own lane
- READY RQ-REROUTED (pool=codex-personal, tier=work): another lane
- READY RQ-WAITING (pool=codex-cmp, tier=work): no launch
`;
const jobs = [
  { event: 'launch', job: 'RQ-OWN', lane: 'codex-personal', model: 'gpt-x' },
  { event: 'launch', job: 'RQ-REROUTED', lane: 'codex-cmp', model: 'gpt-x' },
].map(row => JSON.stringify(row)).join('\n');

afterEach(() => vi.restoreAllMocks());

it('retains requested pools and counts only observed lane differences', () => {
  const report = readBets(vision, jobs);
  expect(report).toMatchObject({ total: 3, merged: 0, rerouted: 1 });
  expect(report.bets).toEqual([
    { id: 'RQ-OWN', status: 'launched', asked_pool: 'codex-personal', lane: 'codex-personal', model: 'gpt-x' },
    { id: 'RQ-REROUTED', status: 'launched', asked_pool: 'codex-personal', lane: 'codex-cmp', model: 'gpt-x', rerouted: true },
    { id: 'RQ-WAITING', status: 'not seen', asked_pool: 'codex-cmp' },
  ]);
  expect(formatBets(report).split('\n')).toEqual([
    'merged 0 of 3',
    'RQ-OWN: launched (codex-personal, gpt-x)',
    'RQ-REROUTED: launched (codex-cmp (asked codex-personal), gpt-x)',
    'RQ-WAITING: not seen',
  ]);
});

it('exposes reroute evidence through the JSON CLI', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBets(['--json'], { vision: async () => vision, jobs: async () => jobs })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(readBets(vision, jobs));
});

it('keeps reroutes visible after merge and deduplicates READY bets', () => {
  const report = readBets(`${vision}- READY RQ-REROUTED (pool=other): duplicate`, `${jobs}\n${JSON.stringify({ event: 'outcome', job: 'RQ-REROUTED', state: 'MERGED', ttm_s: 12 })}`);
  expect(report).toMatchObject({ total: 3, merged: 1, rerouted: 1 });
  expect(formatBets(report)).toContain('RQ-REROUTED: merged (12s to merge) via codex-cmp (asked codex-personal)');
});

it('does not infer reroutes from missing pools, missing lanes or prose', () => {
  const report = readBets(`- READY RQ-OWN: ask pool=other in prose
- READY RQ-MISSING (pool=codex-personal): no lane`, `${jobs}\n${JSON.stringify({ event: 'launch', job: 'RQ-MISSING' })}`);
  expect(report.rerouted).toBe(0);
  expect(report.bets[0]).not.toHaveProperty('asked_pool');
  expect(report.bets[1]).toMatchObject({ asked_pool: 'codex-personal', status: 'launched' });
  expect(readBets(null, null).rerouted).toBe(0);
});
