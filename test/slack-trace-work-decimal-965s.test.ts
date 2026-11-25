import { describe, expect, it } from 'vitest';
import { joinSlackWork } from '../src/web-ui/routes/verse/fleet-channels/slack-trace-work-join.js';

const item = (channelRef: string, id = 'work-1') => ({
  channel: 'slack', channelRef, id, state: 'ASSIGNED', owner: 'example-owner',
});
const board = (items: unknown[]) => ({ inbox: 'ok', truncated: false, items });
const join = (ts: string, ...refs: string[]) => joinSlackWork(ts, 'C123', board(refs.map((ref, i) => item(ref, `work-${i + 1}`))));

describe('Slack work decimal identity', () => {
  it.each(['T123/C123/000123.4500', 'slack:T123:C123:000123.4500'])(
    'retains named ownership for equivalent reference %s', (ref) => {
      expect(join('123.45', ref)).toEqual({ kind: 'item', id: 'work-1', state: 'ASSIGNED', owner: 'example-owner' });
    },
  );
  it('compares the full supported precision without floating point', () => {
    expect(join('12345678901234567890.1234567891', 'T123/C123/12345678901234567890.1234567892')).toEqual({ kind: 'none' });
    expect(join('9007199254740992.1', 'T123/C123/9007199254740993.1')).toEqual({ kind: 'none' });
    expect(join('00000000000000000001.1000000000', 'T123/C123/1.1').kind).toBe('item');
  });
  it('rejects malformed timestamps, extra components and other channels', () => {
    for (const ts of ['1', '1.', '.1', '-1.1', '1.12345678901', '000000000000000000001.1']) {
      expect(join(ts, 'T123/C123/1.1')).toEqual({ kind: 'none' });
    }
    for (const ref of ['T123/C123/1.', 'T123/C123/1.10/extra', 'slack:T123:C123:1.10:extra', 'T123/C456/1.10']) {
      expect(join('1.1', ref)).toEqual({ kind: 'none' });
    }
  });
  it('preserves ambiguity across equivalent references', () => {
    expect(join('1.1', 'T123/C123/01.10', 'slack:T123:C123:1.100')).toEqual({ kind: 'ambiguous', count: 2 });
  });
});
