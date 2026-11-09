import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetLeaderSearch } from '../src/cli/fleet-leader-search.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';
const home = useTmpHome();
beforeEach(() => {
  home.setup();
  const dir = join(home.home(), '.ashlr', 'vision', 'leader');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'thread.jsonl'), JSON.stringify({ id: 'lt-20260101000000-000001', at: '2026-01-01T00:00:00Z', from: 'leader', channel: 'cli', kind: 'message', text: 'Dot release' }), { mode: 0o600 });
});
afterEach(() => { vi.restoreAllMocks(); home.teardown(); });
it('prints text, JSON, empty results, and invalid channels', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetLeaderSearch(['dot', 'release', '--from', 'leader'])).toBe(0);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('leader/cli lt-20260101000000-000001 Dot release'));
  expect(await cmdFleetLeaderSearch(['dot', '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.lastCall![0])).matches).toHaveLength(1);
  expect(await cmdFleetLeaderSearch(['absent'])).toBe(0);
  expect(log).toHaveBeenLastCalledWith('no matches');
  expect(await cmdFleetLeaderSearch(['dot', '--channel', 'bad'])).toBe(2);
  expect(error).toHaveBeenLastCalledWith('invalid --channel');
});
