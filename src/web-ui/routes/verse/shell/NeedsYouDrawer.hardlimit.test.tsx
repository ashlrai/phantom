/**
 * NeedsYouDrawer — the hard-limit chip (t1637u). Each row says whether it
 * truly needs Mason ("Only you: secrets") or Phantom can clear it, and
 * "Only my asks (N)" narrows the list to the hard-limit rows.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNeedsYouItem, type NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { GuardHost, resetGuard } from './guarded-action.js';
import { resetResolvedForTest } from './needs-you-actions.js';
import { NeedsYouDrawer } from './NeedsYouDrawer.js';
import { activity, fixtureNow, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

function need(id: string, title: string): NeedsYouItem {
  const item: NeedsYouItem = {
    id: `chats:agent-waiting:${id}`,
    source: 'chats',
    kind: 'agent-waiting',
    severity: 'info',
    title,
    detail: 'Waiting on the operator.',
    since: new Date(fixtureNow() - 60_000).toISOString(),
    expiresAt: null,
    subject: { repo: null, pr: null, seatId: null, sessionId: null, engine: 'claude' },
    target: { kind: 'terminal', sessionId: null, tabId: id },
    actions: [],
  };
  if (!isNeedsYouItem(item)) throw new Error('fixture is not a valid NeedsYouItem');
  return item;
}

const TOKEN_ASK = need('t-tok1', 'rotate the deploy token');
const FLAKY = need('t-flk1', 'rerun flaky test');

function Harness() {
  const ui = useVerseUi();
  return (
    <>
      {ui.overlay === 'needs-you' ? <NeedsYouDrawer /> : null}
      <GuardHost />
    </>
  );
}

const row = (text: RegExp) => screen.getAllByRole('option').find((o) => text.test(o.textContent ?? ''))!;

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetGuard();
  resetResolvedForTest();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
  vi.stubGlobal('fetch', shellFetch(activity({ needsYou: [TOKEN_ASK, FLAKY] })).fetch);
  resetActivityForTest();
});

afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  resetActivityForTest();
});

describe('hard-limit chips in the drawer', () => {
  it('labels each row and filters to the hard-limit asks', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    act(() => openVerseNeedsYou({ split: 'all' }));
    await screen.findByRole('dialog', { name: /Needs you/ });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(within(row(/deploy token/)).getByText('Only you: secrets')).toBeInTheDocument();
    expect(within(row(/flaky test/)).getByText('Phantom can clear')).toBeInTheDocument();

    const toggle = within(screen.getByRole('toolbar', { name: 'Asks' })).getByRole('button', { name: 'Only my asks (1)' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('rotate the deploy token');

    await user.click(toggle);
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
});
