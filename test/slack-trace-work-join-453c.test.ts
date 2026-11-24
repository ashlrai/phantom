import { describe, expect, it } from 'vitest';
import { joinSlackWork } from '../src/web-ui/routes/verse/fleet-channels/slack-trace-work-join.js';

const TS = '1731400000.000100';
const it1 = (over: object = {}) => ({ id: 'wi-1', channel: 'slack', channelRef: `T0TEAM/C0AGENTS/${TS}`, state: 'RUNNING', owner: 'atlas', ...over });
const board = (items: unknown[], over: object = {}) => ({ inbox: 'ok', truncated: false, items, ...over });

describe('joinSlackWork', () => {
  it('matches a slash ref', () => {
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1()]))).toEqual({ kind: 'item', state: 'RUNNING', owner: 'atlas', id: 'wi-1' });
  });
  it('matches a colon ref', () => {
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1({ channelRef: `slack:T0TEAM:C0AGENTS:${TS}` })])).kind).toBe('item');
  });
  it('ignores non-slack channels', () => {
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1({ channel: 'imessage' })]))).toEqual({ kind: 'none' });
  });
  it('does not match prefix/suffix near-misses', () => {
    expect(joinSlackWork('1731400000.0001', 'C0AGENTS', board([it1()]))).toEqual({ kind: 'none' });
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1({ channelRef: 'T0TEAM/C0AGENTS/1731400000.0001' })]))).toEqual({ kind: 'none' });
  });
  it('reports ambiguous on two matches', () => {
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1(), it1({ id: 'wi-2' })]))).toEqual({ kind: 'ambiguous', count: 2 });
  });
  it('truncated + zero matches is unknown, but a match still wins', () => {
    expect(joinSlackWork('1.1', 'C0AGENTS', board([it1()], { truncated: true }))).toEqual({ kind: 'unknown' });
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1()], { truncated: true })).kind).toBe('item');
  });
  it('unavailable inbox is unknown', () => {
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1()], { inbox: 'unavailable' }))).toEqual({ kind: 'unknown' });
  });
  it('garbage input is unknown and never throws', () => {
    for (const g of [null, undefined, 5, 'x', { items: 'x' }, {}]) expect(joinSlackWork(TS, 'C0AGENTS', g)).toEqual({ kind: 'unknown' });
    expect(joinSlackWork(TS, 'C0AGENTS', board([null, 3, { channel: 'slack', channelRef: 7 }]))).toEqual({ kind: 'none' });
  });
  it('skips items with an invalid state', () => {
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1({ state: 'DONE' })]))).toEqual({ kind: 'none' });
  });
  it('maps an empty owner to null', () => {
    expect(joinSlackWork(TS, 'C0AGENTS', board([it1({ owner: '' })]))).toMatchObject({ kind: 'item', owner: null });
  });
  it('empty threadTs is none on a readable board', () => {
    expect(joinSlackWork('', 'C0AGENTS', board([it1()]))).toEqual({ kind: 'none' });
  });
});
