import { afterEach, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../src/core/verse/fleet-live-api.js', () => ({ buildFleetLiveSnapshot: read }));
import { cmdFleetLaneSlots } from '../src/cli/fleet-lane-slots.js';

afterEach(() => vi.restoreAllMocks());
it('prints the API lane slots in JSON and unknown for expired observations', async () => {
  read.mockResolvedValue({ snapshot: { lanes: [
    { lane: 'local', slots: 4, busy: 1, capReason: null },
    { lane: 'codex', slots: 0, busy: 2, capReason: 'No standing tick has reported lanes in the last 10 minutes.' },
  ] } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetLaneSlots(['--json'])).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ schema: 'fleet.lane-slots.v1',
    lanes: [{ slots: 4, busy: 1 }, { slots: null, busy: 2 }] });
  expect(await cmdFleetLaneSlots([])).toBe(0);
  expect(output.mock.calls.at(-1)![0]).toContain('codex: unknown slots, 2 working');
  expect(await cmdFleetLaneSlots(['--bogus'])).toBe(2);
});
