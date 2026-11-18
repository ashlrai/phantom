import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalsList } from '../../../../core/fleet/approvals.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { isGuardOpen, resetGuard } from '../shell/guard-store.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { APPROVALS_ANSWER_PATH, ApprovalsCard } from './ApprovalsCard.js';

const state = vi.hoisted(() => ({
  read: { status: 'success', data: undefined as unknown },
  post: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => state.refetch }));
vi.mock('../../../data/client.js', async original => ({ ...await original<typeof import('../../../data/client.js')>(), apiPost: state.post }));

const LIST: ApprovalsList = {
  schema: 'approvals.asks.v1', asOf: '2026-11-17T15:00:00.000Z', ledger: 'available', count: 2, expired: 0, approvals: [
    { id: 'nm-3f2a00000001', ref: '3f2a', number: null, kind: 'device', question: 'Approve the fake-device sign-in', options: ['yes', 'no', 'later'],
      askedBy: null, created: '2026-11-17T14:00:00.000Z', ageSeconds: 3600, expires: null },
    { id: 'nm-b7c100000002', ref: '3', number: 3, kind: 'approval', question: 'Use the $40 example credit on the fake plan?', options: ['use it', 'not now'],
      askedBy: 'claude', created: null, ageSeconds: null, expires: '2026-11-17T17:00:00.000Z' },
  ],
};
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390, props: Parameters<typeof ApprovalsCard>[0] = {}) => {
  viewport = mockViewport(width); state.read.data = data; return render(<ApprovalsCard {...props} />);
};
beforeEach(() => { state.post.mockReset(); state.refetch.mockClear(); setMutationToken('example-unlock'); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; resetGuard(); clearMutationToken(); });

describe.each([['390 px', 390], ['desktop width', 1440]])('Decisions card at %s', (_name, width) => {
  it('shows one row per ask with one big button per option, who asked, age and expiry', () => {
    show(LIST, width);
    const card = within(screen.getByRole('region', { name: 'Decisions' }));
    expect(card.getByLabelText('2 waiting').textContent).toBe('2');
    const rows = card.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getAllByRole('button').map(button => button.textContent)).toEqual(['Yes', 'No', 'Later']);
    expect(within(rows[1]!).getAllByRole('button').map(button => button.textContent)).toEqual(['Use it', 'Not now']);
    expect(within(rows[0]!).getByText('Device approval')).toBeTruthy();
    expect(within(rows[0]!).getByText('asked 60 min ago · by unknown · reply “yes 3f2a” from your phone')).toBeTruthy();
    expect(within(rows[1]!).getByText('asked at an unknown time · by claude · expires in 2 h · reply “use it 3” from your phone')).toBeTruthy();
    // Nothing in the card can force sideways scroll at a phone width.
    for (const el of rows[1]!.querySelectorAll<HTMLElement>('*')) expect(el.style.whiteSpace).not.toBe('nowrap');
  });

  it('says "Nothing needs you" in plain words when nothing is waiting, with no buttons', () => {
    show({ ...LIST, count: 0, approvals: [] }, width);
    const card = within(screen.getByRole('region', { name: 'Decisions' }));
    expect(card.getByRole('status').textContent).toBe('Nothing needs you');
    expect(card.queryAllByRole('button')).toHaveLength(0);
  });

  it('labels an outreach ask in plain words and offers Yes / No / Later', () => {
    show({ ...LIST, count: 1, approvals: [{ ...LIST.approvals[0]!, kind: 'outreach', question: 'Send the intro note to Dana' }] }, width);
    const row = within(screen.getByRole('listitem'));
    expect(row.getByText('Message outside the team')).toBeTruthy();
    expect(row.getAllByRole('button').map(button => button.textContent)).toEqual(['Yes', 'No', 'Later']);
  });

  it('is hidden for anything that is not approvals.asks.v1', () => {
    for (const data of [undefined, { error: 'nope' }, { schema: 'asks.v1', asks: [] }]) {
      const view = show(data, width);
      expect(view.container.innerHTML).toBe('');
      cleanup();
    }
  });
});

it('says unknown, with no buttons, when the ledger could not be read', () => {
  show({ ...LIST, ledger: 'unavailable', count: 0, approvals: [] });
  expect(screen.getByText('Unknown: the needs-you ledger could not be read.')).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

it('one tap posts the option to the approvals API with the screen it came from, and the row leaves', async () => {
  state.post.mockResolvedValue({ schema: 'approvals.answer.v1', status: 'answered' });
  show(LIST, 390, { from: 'phone' });
  fireEvent.click(within(screen.getAllByRole('listitem')[1]!).getByRole('button', { name: 'Use it' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Sent: use it.'));
  expect(state.post).toHaveBeenCalledWith(APPROVALS_ANSWER_PATH, { id: 'nm-b7c100000002', option: 'use it', from: 'phone' }, 'example-unlock');
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(state.refetch).toHaveBeenCalled();
});

it('an expired answer drops the row and says why in the server’s words', async () => {
  const { ApiError } = await import('../../../data/client.js');
  state.post.mockRejectedValue(new ApiError('POST failed', 410, APPROVALS_ANSWER_PATH, 'This approval expired at 2026-11-17T17:00:00.000Z; nothing was recorded.'));
  show(LIST);
  fireEvent.click(within(screen.getAllByRole('listitem')[1]!).getByRole('button', { name: 'Not now' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/expired/));
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
});

it('without the unlock a tap asks for the token first and posts nothing yet', () => {
  clearMutationToken();
  show(LIST);
  fireEvent.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: 'Yes' }));
  expect(isGuardOpen()).toBe(true);
  expect(state.post).not.toHaveBeenCalled();
});

it('a read-only phone sees the rows without buttons; the phone caps rows and says when nothing waits', () => {
  show(LIST, 390, { canAnswer: false, limit: 1 });
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByText('1 more after these.')).toBeTruthy();
  cleanup();
  show({ ...LIST, count: 0, approvals: [] }, 390, { emptyNote: 'All quiet.' });
  expect(screen.getByText('All quiet.')).toBeTruthy();
});
