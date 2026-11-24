import { describe, expect, it } from 'vitest';
import { IDLE_LANES_SCHEMA, parseIdleLanes } from '../src/core/fleet/idle-lanes.js';

const lane = { held: false, running: 5, target: 8, queued: 11 };
const parse = (lanes: unknown) => parseIdleLanes(JSON.stringify({ lanes }));

describe('parseIdleLanes', () => {
  it('lists room with queued work as red and held queued work as warn', () => {
    expect(IDLE_LANES_SCHEMA).toBe('fleet.idle-lanes.v1');
    expect(parse({ devin: lane, held: { ...lane, held: true, running: 8 } })).toEqual([
      { lane: 'devin', status: 'red', running: 5, target: 8, queued: 11 },
      { lane: 'held', status: 'warn', running: 8, target: 8, queued: 11 },
    ]);
  });

  it('omits empty queues and unheld lanes with no room', () => {
    expect(parse({ empty: { ...lane, queued: 0 }, heldEmpty: { ...lane, held: true, queued: 0 }, full: { ...lane, running: 8 }, over: { ...lane, running: 9 } })).toEqual([]);
  });

  it('counts room against the launch target after an effective_target shed', () => {
    // Shed from 8 to 5: running 5 is at the launch ceiling, not idle; running 4 still has room.
    expect(parse({
      shedFull: { ...lane, running: 5, effective_target: 5 },
      shedRoom: { ...lane, running: 4, effective_target: 5 },
      shedZero: { ...lane, running: 0, effective_target: 0 },
      malformed: { ...lane, running: 5, effective_target: '5' },
    })).toEqual([
      { lane: 'shedRoom', status: 'red', running: 4, target: 5, queued: 11 },
      { lane: 'malformed', status: 'red', running: 5, target: 8, queued: 11 },
    ]);
  });

  it.each(['running', 'target', 'queued'])('rejects invalid %s counts', field => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(() => parse({ devin: { ...lane, [field]: value } })).toThrow('invalid lane');
    }
  });

  it('requires boolean held and a lanes record', () => {
    expect(() => parse({ devin: { running: 5, target: 8, queued: 11 } })).toThrow('invalid lane');
    expect(() => parse({ devin: { ...lane, held: 'false' } })).toThrow('invalid lane');
    for (const value of ['{}', 'null', '{"lanes":[]}', '{"lanes":null}', 'invalid']) {
      expect(() => parseIdleLanes(value)).toThrow();
    }
  });
});
