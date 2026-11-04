import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetBetWait, explainFleetBetWait, isFillerId, FLEET_BET_WAIT_SCHEMA } from '../src/cli/fleet-bet-wait.js';

afterEach(() => vi.restoreAllMocks());

const tsv = (...rows: string[][]) => rows.map(r => r.join('\t')).join('\n');
const row = (id: string, lane = 'devin') => [id, 'phantom', lane, 'work', 'do it'];

describe('fleet bet-wait', () => {
  it('detects filler ids', () => {
    expect(isFillerId('RQ-FOOA')).toBe(true);
    expect(isFillerId('RQ-FOO1234567')).toBe(true);
    expect(isFillerId('RQ-FOOQ8')).toBe(true);
    expect(isFillerId('RQ-FOO-1')).toBe(false);
  });

  it('counts filler after all other lines and keeps lanes separate', () => {
    const ready = tsv(row('RQ-FILLQ8'), row('RQ-ONE'), row('RQ-OTHER', 'codex'), row('RQ-TWO'));
    const queue = 'RQ-FILLQ8 src=leader\nRQ-ONE src=leader\nRQ-OTHER src=leader\nRQ-TWO src=leader\n';
    const view = explainFleetBetWait(ready, queue);
    expect(view.rows.map(r => [r.id, r.lane, r.place])).toEqual([
      ['RQ-ONE', 'devin', 1], ['RQ-OTHER', 'codex', 1], ['RQ-TWO', 'devin', 2], ['RQ-FILLQ8', 'devin', 3],
    ]);
  });

  it('only lists src=leader whole-token lines', () => {
    const ready = tsv(row('RQ-A1'), row('RQ-B1'), row('RQ-C1'));
    const queue = '- READY RQ-A1 src=leader\n- READY RQ-B1 src=human\n- READY RQ-C1 src=leaderx\n- RQ-A1-RETRY src=leader\n';
    expect(explainFleetBetWait(ready, queue).rows.map(r => r.id)).toEqual(['RQ-A1']);
  });

  it('flags places over 10 and exits 1', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `RQ-N${i}`);
    const ready = tsv(...ids.map(id => row(id)));
    const queue = ids.map(id => `${id} src=leader`).join('\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetBetWait([], { ready: async () => ready, routerQueue: async () => queue });
    expect(code).toBe(1);
    const lines = String(log.mock.calls[0]![0]).split('\n');
    expect(lines[9]).toBe('RQ-N9 devin place 10');
    expect(lines[10]).toBe('RQ-N10 devin place 11 long');
  });

  it('prints json and exits 0 when nothing is long', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetBetWait(['--json'], {
      ready: async () => tsv(row('RQ-ONE')),
      routerQueue: async () => 'RQ-ONE src=leader',
    });
    expect(code).toBe(0);
    const body = JSON.parse(String(log.mock.calls[0]![0]));
    expect(body.schema).toBe(FLEET_BET_WAIT_SCHEMA);
    expect(body.rows).toEqual([{ id: 'RQ-ONE', lane: 'devin', place: 1, filler: false, over: false }]);
  });

  it('exits 2 on unreadable input and bad args, 0 on help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { ready: async () => { throw new Error('nope'); }, routerQueue: async () => '' };
    expect(await cmdFleetBetWait([], bad)).toBe(2);
    expect(await cmdFleetBetWait(['--nope'], bad)).toBe(2);
    expect(await cmdFleetBetWait(['--help'], bad)).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it('is registered', () => {
    expect(FLEET_SUBCOMMAND_LOADERS['bet-wait']).toBeTypeOf('function');
  });
});
