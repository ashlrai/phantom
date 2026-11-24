import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { narrowSlackTrace } from '../src/web-ui/routes/verse/fleet-channels/slack-trace-model.js';
import { joinSlackWork } from '../src/web-ui/routes/verse/fleet-channels/slack-trace-work-join.js';

const ts = '1731400000.000100';
const payload = (channelId: unknown = 'C0AGENTS') => ({
  asOf: '2026-11-15T12:00:00Z', rows: [{ at: '2026-11-15T11:00:00Z', channelId, threadTs: ts,
    messageTs: ts, ingress: 'posted', outcome: 'answered', replyTs: ts }],
  counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 },
  sources: { journal: 'ok', sends: 'ok' }, truncated: false,
});
const item = (channelRef: string, id = 'wi-1') => ({ channel: 'slack', channelRef, id, owner: 'atlas', state: 'RUNNING' });
const board = (items: unknown[], extra: object = {}) => ({ inbox: 'ok', truncated: false, items, ...extra });
const join = (channelId: unknown, data: unknown) => {
  const row = narrowSlackTrace(payload(channelId))!.rows[0]!;
  return joinSlackWork(row.threadTs, row.channelId, data);
};

describe('Slack trace channel identity', () => {
  it('does not expose another channel work item and selects the exact channel', () => {
    const foreign = item(`T0TEAM/C0OTHER/${ts}`, 'foreign');
    const exact = item(`T0TEAM/C0AGENTS/${ts}`);
    expect(join('C0AGENTS', board([foreign]))).toEqual({ kind: 'none' });
    expect(join('C0AGENTS', board([foreign, exact]))).toEqual({ kind: 'item', id: 'wi-1', owner: 'atlas', state: 'RUNNING' });
    expect(join('C0AGENTS', board([item(`slack:T0TEAM:C0AGENTS:${ts}`)]))).toEqual({ kind: 'item', id: 'wi-1', owner: 'atlas', state: 'RUNNING' });
  });
  it('keeps multiple matching entries, including across teams, ambiguous', () => {
    expect(join('C0AGENTS', board([item(`T0TEAM/C0AGENTS/${ts}`), item(`slack:T1TEAM:C0AGENTS:${ts}`)]))).toEqual({ kind: 'ambiguous', count: 2 });
  });
  it('rejects malformed references and missing or malformed request identity', () => {
    for (const id of [null, '', 'C0/AGENTS', 'C'.repeat(65), 42]) {
      expect(join(id, board([item(`T0TEAM/C0AGENTS/${ts}`)]))).toEqual({ kind: 'unknown' });
    }
    for (const ref of [`junk/C0AGENTS/${ts}`, `x:T0TEAM:C0AGENTS:${ts}`, `T0TEAM/C0AGENTS/${ts}/extra`]) {
      expect(join('C0AGENTS', board([item(ref)]))).toEqual({ kind: 'none' });
    }
  });
  it('retains conservative unreadable and truncated board behavior', () => {
    expect(join('C0AGENTS', null)).toEqual({ kind: 'unknown' });
    expect(join('C0AGENTS', board([], { inbox: 'unavailable' }))).toEqual({ kind: 'unknown' });
    expect(join('C0AGENTS', board([item(`T0TEAM/C0OTHER/${ts}`)], { truncated: true }))).toEqual({ kind: 'unknown' });
    expect(join('C0AGENTS', board([item(`T0TEAM/C0AGENTS/${ts}`)], { truncated: true })).kind).toBe('item');
  });
  it('passes the narrowed identity through the component caller', () => {
    const source = readFileSync('src/web-ui/routes/verse/fleet-channels/SlackTraceCard.tsx', 'utf8');
    expect(source).toContain('joinSlackWork(row.threadTs, row.channelId, board)');
  });
});
