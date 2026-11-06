import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueDeadHeads } from '../src/core/fleet/queue-dead-heads.js';
import { cmdFleetDeadHeads } from '../src/cli/fleet-dead-heads.js';
import { fileURLToPath } from 'node:url';

const deferred = Array.from({ length: 8 }, (_, i) => `FAKE-DEAD-${String(i + 1).padStart(2, '0')}`);
const reasons = new Map(deferred.map((job, i) => [job, `after_open_FAKE-DEP-${String(i + 1).padStart(2, '0')}`]));
const ready = [...deferred, 'FAKE-LIVE-09', 'FAKE-LIVE-10'].map(job => `${job}\tdevin\tmid\tfake/repo\tFake job`).join('\n');
afterEach(() => vi.restoreAllMocks());

describe('queue dead heads', () => {
  it('counts eight deferred rounds before the ninth line can launch', () => {
    expect(queueDeadHeads(ready, reasons, 4)).toEqual([{
      lane: 'devin', deadLines: deferred.map((job, i) => ({ job, position: i + 1, reason: reasons.get(job) })),
      firstLaunchablePosition: 9, roundsLost: 8,
    }]);
  });
  it('reports a lane without dead lines and a lane without launchable lines', () => {
    expect(queueDeadHeads(`FAKE-LIVE\tcodex\n${ready.split('\n')[0]}`, reasons, 4)).toMatchObject([
      { lane: 'codex', deadLines: [], firstLaunchablePosition: 1, roundsLost: 0 },
      { lane: 'devin', firstLaunchablePosition: null, roundsLost: 1 },
    ]);
  });
  it('ignores malformed rows, parked lane values and non-ready states', () => {
    expect(queueDeadHeads('job\tpool\tstatus\nFAKE-A\tPARKED-AFTER.devin\tREADY\n../bad\tdevin\tREADY\nFAKE-B\tdevin\tRUNNING\nmissing\nFAKE-C\tdevin\tREADY\n', reasons, 4))
      .toEqual([{ lane: 'devin', deadLines: [], firstLaunchablePosition: 1, roundsLost: 0 }]);
  });
  it('stops after the requested launch cap, counting intervening dead rounds', () => {
    expect(queueDeadHeads(`FAKE-LIVE\tdevin\n${ready}`, reasons, 1)[0]).toMatchObject({ deadLines: [], roundsLost: 0 });
    expect(queueDeadHeads(`FAKE-LIVE\tdevin\n${ready}`, reasons, 2)[0]).toMatchObject({ roundsLost: 8, firstLaunchablePosition: 1 });
    expect(() => queueDeadHeads(ready, reasons, 0)).toThrow(RangeError);
  });
  it('prints the eight fake devin lines through the read-only CLI', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = fileURLToPath(new URL('./fixtures/queue-dead-heads', import.meta.url));
    expect(await cmdFleetDeadHeads(['--root', root, '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]![0]));
    expect(report.schema).toBe('fleet.dead-heads.v1');
    expect(report.lanes).toEqual(queueDeadHeads(ready, reasons, 4));
  });
  it('rejects invalid options and reports unavailable evidence without filesystem details', async () => {
    expect(await cmdFleetDeadHeads(['--cap', '0'])).toBe(2);
    expect(await cmdFleetDeadHeads(['--write'])).toBe(2);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetDeadHeads(['--root', fileURLToPath(new URL('./fixtures/queue-dead-heads/absent', import.meta.url))])).toBe(1);
    expect(error).toHaveBeenCalledWith('fleet dead-heads: queue evidence unavailable');
  });
});
