import { expect, it } from 'vitest';
import { ownerThreadLines, mergeOwnerLines } from './owner-thread-lines.js';
import { parseOwnerThread } from './owner-thread-queries.js';
import type { MergedLine } from './thread-merge-model.js';

const T = Date.parse('2026-11-09T12:00:30.000Z');
const row = (over: Record<string, unknown>) => ({ seq: 1, id: 'm1', channel: 'imessage', senderId: 'imessage:+15555550100', direction: 'inbound', at: new Date(T).toISOString(), text: 'hello from phone', ...over });
const body = (messages: unknown[]) => ({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages });

it('maps inbound iMessage and Telegram and outbound fanout', () => {
  const lines = ownerThreadLines(parseOwnerThread(body([
    row({ id: 'a' }),
    row({ id: 'b', channel: 'telegram', senderId: 'telegram:1', text: 'hi tg' }),
    row({ id: 'c', channel: 'desktop', direction: 'outbound', senderId: 'leader', fanout: ['telegram', 'imessage'], text: 'on it' }),
  ])), []);
  expect(lines.map(l => [l.id, l.who, l.source, l.label])).toEqual([
    ['owner-a', 'mason', 'imessage', 'Mason via iMessage'],
    ['owner-b', 'mason', 'telegram', 'Mason via Telegram'],
    ['owner-c', 'leader', 'desktop', 'Leader → Telegram, iMessage'],
  ]);
});

it('drops a desktop line already mirrored into the fleet inbox, same minute only', () => {
  const inbox: MergedLine = { at: T - 20_000, who: 'mason', source: 'desktop', text: 'ship it', id: 'inbox-0', ack: null };
  const out = ownerThreadLines(parseOwnerThread(body([
    row({ id: 'd1', channel: 'desktop', text: 'ship it' }),
    row({ id: 'd2', channel: 'desktop', text: 'ship it', at: new Date(T + 120_000).toISOString() }),
    row({ id: 'p1', text: 'ship it' }),
  ])), [inbox]);
  expect(out.map(l => l.id)).toEqual(['owner-d2', 'owner-p1']);
});

it('skips malformed rows and bad bodies', () => {
  expect(parseOwnerThread(body([row({ id: 'ok' }), null, row({ direction: 'sideways' }), row({ text: 4 }), { id: 'x' }])).map(r => r.id)).toEqual(['ok']);
  expect(ownerThreadLines([row({ at: 'garbage' }) as never], [])).toEqual([]);
  for (const bad of [null, 'x', [], { schema: 'other', messages: [] }, { ...body([row({})]), unavailable: true }, { schema: 'comms.owner-thread.v1' }]) expect(parseOwnerThread(bad)).toEqual([]);
});

it('folds owner lines into the fleet lines by time', () => {
  const l = (id: string, at: number): MergedLine => ({ at, who: 'mason', source: 'x', text: id, id, ack: null });
  expect(mergeOwnerLines([l('a', 1), l('c', 3)], [l('d', 4), l('b', 2)]).map(x => x.id)).toEqual(['a', 'b', 'c', 'd']);
});
