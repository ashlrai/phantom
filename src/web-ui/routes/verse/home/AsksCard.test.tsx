import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsksList } from '../../../../core/fleet/asks.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ASKS_ANSWER_PATH, AsksCard } from './AsksCard.js';

const state = vi.hoisted(() => ({
  read: { status: 'success', data: undefined as unknown },
  hold: { hasHold: true, token: 'example-unlock' as string | null, touch: vi.fn() },
  post: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => state.refetch, useMutationHold: () => state.hold }));
vi.mock('../../../data/client.js', async original => ({ ...await original<typeof import('../../../data/client.js')>(), apiPost: state.post }));

const ASKS: AsksList = {
  schema: 'asks.v1', asOf: '2026-11-17T15:00:00.000Z', ledger: 'available', count: 2, fleetDecides: 1, asks: [
    { id: 'nm-3f2a00000001', shortId: '3f2a', kind: 'device', request: 'Approve the fake-device sign-in', created: '2026-11-17T14:00:00.000Z', ageSeconds: 3600 },
    { id: 'nm-b7c100000002', shortId: 'b7c1', kind: '2fa', request: 'Enter the example-ask 2FA code', created: null, ageSeconds: null },
  ],
};
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390) => { viewport = mockViewport(width); state.read.data = data; return render(<AsksCard />); };
beforeEach(() => { state.post.mockReset(); state.refetch.mockClear(); state.hold = { hasHold: true, token: 'example-unlock', touch: vi.fn() }; });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['390 px', 390], ['desktop width', 1440]])('Asks card at %s', (_name, width) => {
  it('shows the count and each ask with Yes, No and Done', () => {
    show(ASKS, width);
    const card = within(screen.getByRole('region', { name: 'Asks' }));
    expect(card.getByLabelText('2 waiting').textContent).toBe('2');
    const rows = card.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getAllByRole('button').map(button => button.textContent)).toEqual(['Yes', 'No', 'Done']);
    expect(within(rows[0]!).getByText(/asked 60 min ago/)).toBeTruthy();
    expect(within(rows[1]!).getByText(/asked at an unknown time · reply “yes b7c1” from your phone/)).toBeTruthy();
  });

  it('is hidden when nothing is asked, and for anything that is not asks.v1', () => {
    for (const data of [{ ...ASKS, count: 0, asks: [] }, undefined, { error: 'nope' }, { schema: 'home.v1' }]) {
      const view = show(data, width);
      expect(view.container.innerHTML).toBe('');
      cleanup();
    }
  });
});

it('says unknown, with no buttons, when the ledger could not be read', () => {
  show({ ...ASKS, ledger: 'unavailable', count: 0, asks: [] });
  expect(screen.getByText('Unknown: the needs-you ledger could not be read.')).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

it('one tap posts the answer to the asks API and the ask leaves the card', async () => {
  state.post.mockResolvedValue({ schema: 'asks.answer.v1', status: 'answered' });
  show(ASKS);
  fireEvent.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: 'Yes' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Sent: yes.'));
  expect(state.post).toHaveBeenCalledWith(ASKS_ANSWER_PATH, { id: 'nm-3f2a00000001', answer: 'yes' }, 'example-unlock');
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(state.refetch).toHaveBeenCalled();
});

it('without an unlock the buttons are disabled and say why', () => {
  state.hold = { hasHold: false, token: null, touch: vi.fn() };
  show(ASKS);
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Unlock to answer here.')).toBeTruthy();
});
