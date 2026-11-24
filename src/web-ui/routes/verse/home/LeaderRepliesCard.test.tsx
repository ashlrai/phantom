import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeaderRepliesV1, LeaderReply } from '../../../../core/fleet/mason-outbox.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { LeaderRepliesCard, replyWhen } from './LeaderRepliesCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => vi.fn() }));

const reply = (at: string, text: string, source: LeaderReply['source'] = 'plan-log'): LeaderReply => ({ at, text, source });
const report = (replies: LeaderReply[], extra: Partial<LeaderRepliesV1> = {}): LeaderRepliesV1 => ({ schema: 'leader.replies.v1', version: 1, sourceState: 'healthy', replies, entries: [], ...extra });
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390, limit?: number) => {
  viewport = mockViewport(width);
  state.read = { status: 'success', data };
  render(<LeaderRepliesCard limit={limit} />);
  return within(screen.getByRole('region', { name: 'From your leader' }));
};
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['390 px', 390], ['desktop width', 1440]])('From your leader card at %s', (_name, width) => {
  it('says so in plain words when there are no replies', () => {
    const card = show(report([]), width);
    expect(card.getByRole('status').textContent).toBe('No replies yet.');
    expect(card.queryAllByRole('listitem')).toEqual([]);
  });

  it('shows one reply with its time and its words as written', () => {
    const card = show(report([reply('2026-11-17 10:00', 'Main is "green".\nQueue is moving.')]), width);
    expect(card.getAllByRole('listitem').map(item => item.textContent)).toEqual(['2026-11-17 10:00 ETMain is "green".\nQueue is moving.']);
    expect(card.queryByRole('status')).toBeNull();
  });

  it('shows several replies newest first, up to its limit, and unknown time as unknown', () => {
    const replies = [reply('unknown', 'No clock here.'), reply('2026-11-17 10:00', 'Second.'), reply('2026-11-17 09:00', 'Third.'), reply('2026-11-17 08:00', 'Fourth.')];
    const card = show(report(replies), width);
    expect(card.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Time unknownNo clock here.', '2026-11-17 10:00 ETSecond.', '2026-11-17 09:00 ETThird.']);
    expect(card.getByText('Time unknown').hasAttribute('data-unknown')).toBe(true);
  });
});

it('shows the newest reply only on the phone', () => {
  const card = show(report([reply('2026-11-17 10:00', 'First.'), reply('2026-11-17 09:00', 'Second.')]), 390, 1);
  expect(card.getAllByRole('listitem')).toHaveLength(1);
});

it('says unknown with the reason when the plan log is missing, and still shows what it has', () => {
  const card = show(report([reply('2026-11-17T14:00:00Z', 'From the outbox.', 'outbox')], { sourceState: 'missing', reason: 'No PLAN-LOG file at /fake/PLAN-LOG.md, so there are no replies yet.' }));
  expect(card.getByText('Unknown: No PLAN-LOG file at /fake/PLAN-LOG.md, so there are no replies yet.').hasAttribute('data-unknown')).toBe(true);
  expect(card.getAllByRole('listitem')).toHaveLength(1);
});

it('stays hidden before the first read and for any other payload', () => {
  for (const data of [undefined, null, { schema: 'home.v1' }, { error: 'not found' }]) {
    state.read = { status: 'success', data };
    render(<LeaderRepliesCard />);
    expect(screen.queryByRole('region', { name: 'From your leader' })).toBeNull();
    cleanup();
  }
});

it('reads Eastern wall time as written and anything unreadable as unknown', () => {
  expect(replyWhen('2026-11-17 10:00')).toBe('2026-11-17 10:00 ET');
  expect(replyWhen('2026-11-17')).toBe('2026-11-17 ET');
  expect(replyWhen('unknown')).toBe('Time unknown');
  expect(replyWhen('2026-11-17T14:00:00Z')).not.toBe('Time unknown');
});
