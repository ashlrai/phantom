import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBrief } from '../src/cli/fleet-brief.js';
import { readLeaderBrief, type BriefReaders } from '../src/core/fleet/leader-brief.js';

afterEach(() => vi.restoreAllMocks());
it('prints fixture readings as JSON and plain text', async () => {
  const readers: BriefReaders = { fleet: () => ({ merges24h: 3, openPrs: 7 }), installed: () => '1.0.0', latest: () => '1.1.0', needsMason: () => 2, goals: () => [], lanes: () => ['codex 1/2'] };
  const read = () => readLeaderBrief({ readers, now: () => 0 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief(['--json'], read)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ merges24h: 3, openPrs: 7, needsMason: 2, release: { behind: true } });
  expect(await cmdFleetBrief([], read)).toBe(0);
  expect(log.mock.calls[1]![0]).toContain('codex 1/2');
});
