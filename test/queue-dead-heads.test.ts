import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueDeadHeads, ledgerDeadHeadSkips } from '../src/core/fleet/queue-dead-heads.js';
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
  it('reads live skipped_empty ledger events when no marker files exist', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = fileURLToPath(new URL('./fixtures/queue-dead-heads-ledger', import.meta.url));
    expect(await cmdFleetDeadHeads(['--root', root, '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]![0]));
    expect(report.lanes).toEqual([{
      lane: 'devin',
      deadLines: [
        { job: 'RQ-LEDGER-DEAD-01', position: 1, reason: 'prompt_empty_same_base_24h' },
        { job: 'RQ-LEDGER-OVER-04', position: 4, reason: 'task_empty_repeat_24h' },
      ],
      firstLaunchablePosition: 2, roundsLost: 2,
    }]);
  });
});

describe('ledger dead-head skips', () => {
  it('folds skipped_empty rows to one verdict per job, last row wins', () => {
    const verdicts = ledgerDeadHeadSkips([
      '{"event":"skipped_empty","job":"RQ-A","lane":"devin","reason":"old_reason","ts":"2026-11-20T09:00:00+0000"}',
      '{"event":"skipped_empty","job":"RQ-A","lane":"devin","reason":"new_reason","ts":"2026-11-20T10:00:00+0000"}',
      '{"event":"launch","job":"RQ-B","lane":"devin","ts":"2026-11-20T10:00:00+0000"}',
      'not json',
      '{"event":"skipped_empty","job":"RQ-C","reason":"task_empty_repeat_24h"}',
    ].join('\n'));
    expect(verdicts.get('RQ-A')).toEqual({ dead: true, reason: 'new_reason' });
    expect(verdicts.has('RQ-B')).toBe(false);
    expect(verdicts.get('RQ-C')).toEqual({ dead: true, reason: 'task_empty_repeat_24h' });
  });
  it('excludes coded precheck declines and lets the last applied verdict win', () => {
    const verdicts = ledgerDeadHeadSkips([
      '{"event":"skipped_empty","job":"RQ-PRECHECK","code":11,"ts":"2026-11-20T10:00:00+0000"}',
      '{"event":"skipped_empty","job":"RQ-DRY","reason":"prompt_empty_same_base_24h","applied":false}',
      '{"event":"skipped_empty","job":"RQ-DRY","reason":"prompt_empty_same_base_24h","applied":true}',
    ].join('\n'));
    expect(verdicts.has('RQ-PRECHECK')).toBe(false);
    expect(verdicts.get('RQ-DRY')).toEqual({ dead: true, reason: 'prompt_empty_same_base_24h' });
  });
  it('reads the event/type/kind and job id dialects and keeps a missing reason null', () => {
    const verdicts = ledgerDeadHeadSkips([
      '{"type":"skipped_empty","jobId":"RQ-DIALECT"}',
      '{"event":"skipped_empty","job":"RQ-NOREASON","lane":"devin"}',
    ].join('\n'));
    expect(verdicts.get('RQ-DIALECT')).toEqual({ dead: true, reason: null });
    expect(verdicts.get('RQ-NOREASON')).toEqual({ dead: true, reason: null });
  });
  it('returns an empty map for a missing ledger', () => {
    expect(ledgerDeadHeadSkips(null).size).toBe(0);
  });
});
