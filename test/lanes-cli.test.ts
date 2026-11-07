import { afterEach, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../src/core/verse/fleet-live-api.js', () => ({ buildFleetLiveSnapshot: read }));
import { cmdLanes } from '../src/cli/lanes.js';

afterEach(() => vi.restoreAllMocks());
it('prints lanes.health.v1 JSON and plain text, rejects other verbs', async () => {
  read.mockResolvedValue({ snapshot: { v: 1, generatedAt: '2026-11-02T12:00:00.000Z', commit: 'abc1234',
    lanes: [{ lane: 'codex', slots: 1, busy: 1, capReason: null }],
    runs: [{ id: 'r', repo: 'a/b', lane: 'codex', phase: 'producing', startedAt: '2026-11-02T11:00:00.000Z',
      phaseStartedAt: '2026-11-02T11:00:00.000Z', endedAt: null, outcome: null }] } });
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdLanes(['health', '--json'])).toBe(0);
  const json = JSON.parse(out.mock.calls[0]![0]);
  expect(json).toMatchObject({ schema: 'lanes.health.v1', commit: 'abc1234',
    lanes: [{ lane: 'codex', calls: 1, errorRate: null, stuck: [{ runId: 'r', phase: 'producing' }] }] });
  expect(await cmdLanes(['health'])).toBe(0);
  expect(out.mock.calls.at(-1)![0]).toContain('[stuck · producing 1h]');
  expect(await cmdLanes(['bogus'])).toBe(2);
  expect(await cmdLanes(['health', '--x'])).toBe(2);
  expect(err).toHaveBeenCalled();
});
