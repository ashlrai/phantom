// Recut of #4355 (RQ-PHX-LEADERBRIEFCORE13): `phm fleet brief` prints the
// Leader's status brief. Readings are injected; nothing touches HOME or network.
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBrief } from '../src/cli/fleet-brief.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { readLeaderBrief, type BriefReaders } from '../src/core/fleet/leader-brief.js';

afterEach(() => vi.restoreAllMocks());

const readers: BriefReaders = {
  fleet: () => ({ merges24h: 12, openPrs: null }),
  installed: () => '3.30.27',
  latest: () => '3.30.28',
  needsMason: () => null,
  goals: () => [
    { objective: 'Shipped goal', status: 'done', fractionDone: 1 },
    { objective: 'Paused goal', status: 'paused', fractionDone: 0.9 },
    { objective: 'Barely started', status: 'active', fractionDone: 0.004 },
    { objective: 'Nearly there', status: 'active', fractionDone: 0.996 },
    { objective: 'Planning goal', status: 'planning', fractionDone: null },
  ],
  lanes: () => { throw new Error('runs dir unreadable'); },
};

it('registers the verb and prints the brief as plain text', async () => {
  expect(Object.keys(await FLEET_SUBCOMMAND_LOADERS.brief!())).toContain('cmdFleetBrief');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief([], () => readLeaderBrief({ readers, now: () => 0 }))).toBe(0);
  expect(log.mock.calls[0]![0]).toBe([
    'Merges (24h): 12; open PRs: unknown',
    'Release: installed 3.30.27; latest published 3.30.28',
    'Needs Mason: unknown',
    // Open goals only, active first by progress, one-percent rule; done goal and the 4th open goal dropped.
    'Goals: Nearly there (99%); Barely started (<1%); Planning goal (unknown)',
    // A throwing reader degrades to unknown instead of failing the brief.
    'Lanes: unknown',
  ].join('\n'));
});

it('emits machine-readable facts with --json and rejects unknown flags', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = () => readLeaderBrief({ readers, now: () => 0 });
  expect(await cmdFleetBrief(['--json'], read)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
    at: '1970-01-01T00:00:00.000Z', merges24h: 12, openPrs: null, needsMason: null, lanes: [],
    release: { installed: '3.30.27', latest: '3.30.28', behind: true },
  });
  expect(await cmdFleetBrief(['--apply'], read)).toBe(2);
  expect(err).toHaveBeenCalledWith('Usage: ashlr fleet brief [--json]');
});

// Carried over from #4355's test/fleet-brief-cli.test.ts.
it('prints fixture readings as JSON and plain text', async () => {
  const fixture: BriefReaders = { fleet: () => ({ merges24h: 3, openPrs: 7 }), installed: () => '1.0.0', latest: () => '1.1.0', needsMason: () => 2, goals: () => [], lanes: () => ['codex 1/2'] };
  const read = () => readLeaderBrief({ readers: fixture, now: () => 0 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief(['--json'], read)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ merges24h: 3, openPrs: 7, needsMason: 2, release: { behind: true } });
  expect(await cmdFleetBrief([], read)).toBe(0);
  expect(log.mock.calls[1]![0]).toContain('codex 1/2');
  expect(log.mock.calls[1]![0]).toContain('Goals: none');
});
