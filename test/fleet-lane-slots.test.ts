import { afterEach, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../src/core/verse/fleet-live-api.js', () => ({ buildFleetLiveSnapshot: read }));
import { cmdFleetLaneSlots } from '../src/cli/fleet-lane-slots.js';

afterEach(() => vi.restoreAllMocks());
it('preserves observed slot counts, including zero', async () => {
  read.mockResolvedValue({ laneSlotsObserved: true, snapshot: { lanes: [
    { lane: 'local', slots: 4, busy: 1, capReason: null },
    { lane: 'codex', slots: 0, busy: 2, capReason: 'off' },
  ] } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetLaneSlots(['--json'])).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ schema: 'fleet.lane-slots.v1',
    lanes: [{ slots: 4, busy: 1 }, { slots: 0, busy: 2 }] });
  expect(await cmdFleetLaneSlots(['--bogus'])).toBe(2);
});

it.each([
  'No standing tick has reported lanes in the last 10 minutes.',
  'Autonomous dispatch is paused.',
  'Stop is in force.',
  'No standing grant is in force.',
])('reports unobserved slots as unknown with reason %s', async (capReason) => {
  read.mockResolvedValue({ laneSlotsObserved: false, snapshot: { lanes: [
    { lane: 'codex', slots: 0, busy: 2, capReason },
  ] } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetLaneSlots(['--json'])).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ lanes: [{ slots: null, busy: 2, capReason }] });
  expect(await cmdFleetLaneSlots([])).toBe(0);
  expect(output.mock.calls.at(-1)![0]).toContain('codex: unknown slots, 2 working');
});
