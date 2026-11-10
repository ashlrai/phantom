import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBrief } from '../src/cli/fleet-brief.js';
import { readLeaderBrief, type BriefReaders } from '../src/core/fleet/leader-brief.js';

afterEach(() => vi.restoreAllMocks());

it('preserves the read-only Leader brief through JSON and text with independent readings', async () => {
  const calls: string[] = [];
  const send = vi.spyOn(globalThis, 'fetch');
  const mutate = vi.spyOn(fs, 'writeFileSync');
  const readers: BriefReaders = {
    fleet: () => { calls.push('fleet'); return { merges24h: 4, openPrs: null }; },
    installed: () => { calls.push('installed'); return '1.2.3'; },
    latest: () => { calls.push('latest'); return '1.3.0'; },
    needsMason: () => { calls.push('needsMason'); throw new Error('unavailable'); },
    goals: () => { calls.push('goals'); return [
      { objective: 'Plan next', status: 'planning', fractionDone: 0.9 },
      { objective: 'Active low', status: 'active', fractionDone: 0.001 },
      { objective: 'Finished', status: 'done', fractionDone: 1 },
      { objective: 'Active high', status: 'active', fractionDone: 0.999 },
    ]; },
    lanes: () => { calls.push('lanes'); return ['codex 2/3', 'claude 1/1']; },
  };
  const read = () => readLeaderBrief({ readers, now: () => 0 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief(['--json'], read)).toBe(0);
  const brief = JSON.parse(log.mock.calls[0]![0] as string);
  expect(brief).toMatchObject({
    at: '1970-01-01T00:00:00.000Z', merges24h: 4, openPrs: null, needsMason: null,
    release: { installed: '1.2.3', latest: '1.3.0', behind: true },
    goals: [
      { objective: 'Active high', percentText: '99%' },
      { objective: 'Active low', percentText: '<1%' },
      { objective: 'Plan next', percentText: '90%' },
    ],
    lanes: ['codex 2/3', 'claude 1/1'],
  });
  expect(await cmdFleetBrief([], read)).toBe(0);
  const text = log.mock.calls[1]![0] as string;
  expect(text).toBe(brief.text);
  expect(text).toContain('Merges (24h): 4; open PRs: unknown');
  expect(text).toContain('Release: installed 1.2.3; latest published 1.3.0');
  expect(text).toContain('Needs Mason: unknown');
  expect(text).toContain('Goals: Active high (99%); Active low (<1%); Plan next (90%)');
  expect(text).toContain('Lanes: codex 2/3; claude 1/1');
  expect(text.length).toBeLessThanOrEqual(700);
  expect(calls.sort()).toEqual(['fleet', 'goals', 'installed', 'lanes', 'latest', 'needsMason'].flatMap(x => [x, x]).sort());
  expect(send).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
});

it('bounds a long brief while keeping independently failed fleet readings unknown', async () => {
  const readers: BriefReaders = {
    fleet: () => { throw new Error('unavailable'); },
    installed: () => null, latest: () => null, needsMason: () => null,
    goals: () => Array.from({ length: 8 }, (_, i) => ({ objective: `${i}${'x'.repeat(1000)}`, status: 'active', fractionDone: null })),
    lanes: () => Array.from({ length: 10 }, (_, i) => `${i}${'y'.repeat(1000)}`),
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief(['--json'], () => readLeaderBrief({ readers, now: () => 0 }))).toBe(0);
  const brief = JSON.parse(log.mock.calls[0]![0] as string);
  expect(brief).toMatchObject({ merges24h: null, openPrs: null, needsMason: null, release: { installed: null, latest: null, behind: null } });
  expect(brief.goals).toHaveLength(3);
  expect(brief.lanes).toHaveLength(6);
  expect(brief.text).toContain('Merges (24h): unknown; open PRs: unknown');
  expect(brief.text.length).toBeLessThanOrEqual(700);
});
