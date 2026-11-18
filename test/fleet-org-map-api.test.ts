import { expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const mocks = vi.hoisted(() => ({ send: vi.fn(), live: vi.fn(), sessions: vi.fn(), messages: vi.fn() }));
vi.mock('../src/core/web/api.js', () => ({ sendJson: mocks.send }));
vi.mock('../src/core/verse/fleet-live-api.js', () => ({ buildFleetLiveSnapshot: mocks.live }));
vi.mock('../src/core/fleet/runs-sessions.js', () => ({ getFleetSessions: mocks.sessions }));
vi.mock('../src/core/fleet/fleet-edges.js', () => ({ readFleetEdges: mocks.messages }));
import { createFleetOrgMapApi, fleetOrgReaders, readFleetOrgMap } from '../src/core/verse/fleet-org-map-api.js';
import { cmdFleetMap } from '../src/cli/fleet-map.js';
import { fleetOrgMap } from '../src/core/fleet/org-map.js';

it('serves only authenticated GETs with a bounded window and sanitizes failures', async () => {
  const read = vi.fn().mockResolvedValue(fleetOrgMap(null)), api = createFleetOrgMapApi(read), path = '/api/verse/fleet/control/map';
  const call = (url = path, method = 'GET', authenticated = true) => api({ readSession: authenticated ? { expiresAt: Date.now() + 60_000 } : undefined } as VerseApiContext,
    { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);
  expect(await call('/unrelated')).toBe(false);
  await call(path, 'POST'); expect(mocks.send.mock.lastCall?.[1]).toBe(405);
  await call(path, 'GET', false); expect(mocks.send.mock.lastCall?.[1]).toBe(401);
  for (const query of ['minutes=0', 'minutes=1&minutes=2', 'root=fixture']) { await call(`${path}?${query}`); expect(mocks.send.mock.lastCall?.[1]).toBe(400); }
  expect(read).not.toHaveBeenCalled();
  await call(`${path}?minutes=5`); expect(read).toHaveBeenCalledWith(5); expect(mocks.send.mock.lastCall?.[1]).toBe(200);
  read.mockRejectedValueOnce(new Error('private fixture diagnostic'));
  await call(); expect(mocks.send.mock.lastCall?.slice(1)).toEqual([503, { error: 'Fleet map unavailable.' }]);
});
it('shares the CLI contract, rejects bad flags without reads, and keeps failed sources unknown', async () => {
  mocks.live.mockRejectedValue(new Error('fixture failure')); mocks.sessions.mockRejectedValue(new Error('fixture failure'));
  mocks.messages.mockReturnValue({ schema: 'fleet.edges.v1', source: 'missing', edges: null });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const clock = vi.spyOn(fleetOrgReaders, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00Z'));
  try {
    for (const args of [['--minutes'], ['--minutes', '0'], ['--json', '--json'], ['--apply']]) expect(await cmdFleetMap(args)).toBe(2);
    expect(mocks.live).not.toHaveBeenCalled();
    expect(await cmdFleetMap(['--minutes', '5', '--json'])).toBe(0);
    const graph = JSON.parse(output.mock.lastCall![0]);
    expect(graph).toMatchObject({ schema: 'fleet.map.v2', messageWindowMinutes: 5, sources: { fleet: 'unknown', sessions: 'unknown', messages: 'missing' } });
    expect(mocks.messages).toHaveBeenCalledWith(expect.objectContaining({ windowMinutes: 5 }));
    expect(await readFleetOrgMap(5)).toEqual(graph);
  } finally { output.mockRestore(); clock.mockRestore(); }
});
