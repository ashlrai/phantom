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

  it('measures room against the shed-aware launch target', () => {
    expect(parse({
      shedFull: { ...lane, running: 6, effective_target: 5 },
      shedRoom: { ...lane, running: 4, effective_target: 5 },
      heldShed: { ...lane, held: true, running: 9, effective_target: 5 },
    })).toEqual([
      { lane: 'shedRoom', status: 'red', running: 4, target: 8, queued: 11 },
      { lane: 'heldShed', status: 'warn', running: 9, target: 8, queued: 11 },
    ]);
  });

  it('rejects malformed effective_target readings and treats null as absent', () => {
    for (const value of [-1, 0.5, '6', true]) {
      expect(() => parse({ devin: { ...lane, effective_target: value } })).toThrow('invalid lane');
    }
    expect(parse({ devin: { ...lane, effective_target: null }, shed: { ...lane, effective_target: 4 } })).toEqual([
      { lane: 'devin', status: 'red', running: 5, target: 8, queued: 11 },
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
