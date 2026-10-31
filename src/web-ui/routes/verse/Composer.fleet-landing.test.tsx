import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from './Composer.js';
import { CLAUDE_SEAT } from './fixtures.test-support.js';
import { clearComposerMemory } from './chat/composer-state.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { refetchQuery } from '../../data/cache.js';
import { opsRunsQuery } from './ops/ops-runs-queries.js';
import { openDockPane } from './dock/dock-store.js';
import { setVerseSection } from './verse-ui-store.js';
import { setFocusMode } from './shell/focus-mode.js';

vi.mock('../../data/cache.js', async (original) => ({
  ...await original<typeof import('../../data/cache.js')>(),
  refetchQuery: vi.fn(async () => {}),
}));
vi.mock('./dock/dock-store.js', async (original) => ({
  ...await original<typeof import('./dock/dock-store.js')>(), openDockPane: vi.fn(),
}));
vi.mock('./verse-ui-store.js', async (original) => ({
  ...await original<typeof import('./verse-ui-store.js')>(), setVerseSection: vi.fn(),
}));
vi.mock('./shell/focus-mode.js', async (original) => ({
  ...await original<typeof import('./shell/focus-mode.js')>(), setFocusMode: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  clearComposerMemory();
  setMutationToken('fake-fleet-test-token');
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/fleet/runs/inbox')) return Response.json({ at: '2026-10-31 00:13' });
    return Response.json({ seats: [] });
  }));
});
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function sendToFleet() {
  const onSend = vi.fn();
  render(<Composer seats={[CLAUDE_SEAT]} seat={{ seatId: CLAUDE_SEAT.id, model: 'claude-opus-5' }}
    engine="claude" running={false} disabled={false} locked={false}
    onSend={onSend} onStop={vi.fn()} onSeatChange={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '/fleet Please prioritize tests' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send message' })); });
  return onSend;
}

it('confirms delivery, refreshes runs once, and reveals the Inbox in chat', async () => {
  vi.useFakeTimers();
  const onSend = await sendToFleet();
  expect(screen.getByText("Sent to the leaders' inbox · 00:13 · open Inbox to confirm")).toBeInTheDocument();
  const refresh = vi.spyOn(opsRunsQuery, 'fetch').mockResolvedValue(null);
  try {
    expect(refetchQuery).toHaveBeenCalledTimes(1);
    expect(refetchQuery).toHaveBeenCalledWith(opsRunsQuery.key, expect.any(Function), true);
    const fetchRuns = vi.mocked(refetchQuery).mock.calls[0]![1];
    await fetchRuns();
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally { refresh.mockRestore(); }
  fireEvent.click(screen.getByRole('button', { name: 'Open inbox' }));
  expect(setVerseSection).toHaveBeenCalledWith('chat');
  expect(setFocusMode).toHaveBeenCalledWith(false);
  expect(openDockPane).toHaveBeenCalledWith('fleet-inbox');
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  act(() => { vi.advanceTimersByTime(8000); });
  expect(screen.queryByRole('button', { name: 'Open inbox' })).not.toBeInTheDocument();
});

it('keeps a failed post sticky without an inbox action or refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith('/fleet/runs/inbox')
      ? Response.json({ error: 'Fleet inbox write failed' }, { status: 500 })
      : Response.json({ seats: [] })));
  await sendToFleet();
  expect(await screen.findByRole('alert')).toHaveTextContent('Fleet inbox write failed');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Open inbox' })).not.toBeInTheDocument();
  expect(refetchQuery).not.toHaveBeenCalled();
  vi.useFakeTimers();
  act(() => { vi.advanceTimersByTime(8001); });
  expect(screen.getByRole('alert')).toHaveTextContent('Fleet inbox write failed');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('/fleet Please prioritize tests');
});
