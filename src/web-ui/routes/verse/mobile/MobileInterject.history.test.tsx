import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { HISTORY_KEY, loadHistory } from '../fleet/interject-history.js';
import { MobileInterject } from './MobileInterject.js';
import { resetMobileToastsForTest } from './mobile-toast.js';
import { json, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

const older = 'An earlier message';
const newer = 'A newer message long enough to be truncated in the recent row';

beforeEach(() => {
  localStorage.setItem(HISTORY_KEY, JSON.stringify([older, newer]));
  sessionStorage.clear();
  setMutationToken(TOKEN);
});
afterEach(() => {
  localStorage.removeItem(HISTORY_KEY);
  clearMutationToken();
  evictAll();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
});

describe('mobile interject history', () => {
  it('recalls the newest message and saves a successful send', async () => {
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': { inbox: [] },
      'POST /api/verse/fleet/runs/inbox': { ok: true, at: '2026-10-31T04:12:00Z' },
    });
    renderMobile(<MobileInterject />);
    const field = screen.getByRole('textbox', { name: 'Message to the leaders' });
    const chips = within(screen.getByRole('group', { name: 'Recent messages' })).getAllByRole('button');
    expect(chips).toHaveLength(2);
    expect(chips.map(chip => chip.textContent)).toEqual([`↑ ${newer.slice(0, 40)}`, `↑ ${older}`]);
    fireEvent.click(chips[0]!);
    expect(field).toHaveValue(newer);
    expect(field).toHaveFocus();
    expect(stub.posts()).toHaveLength(0);
    expect(screen.queryByRole('group', { name: 'Recent messages' })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'A refined order' } });
    expect(screen.queryByRole('group', { name: 'Recent messages' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(loadHistory(localStorage).at(-1)).toBe('A refined order'));
    expect(within(screen.getByRole('group', { name: 'Recent messages' })).getAllByRole('button')[0]).toHaveTextContent('A refined order');
  });

  it('shows only the five most recent messages and does not save a failed send', async () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(['one', 'two', 'three', 'four', 'five', 'six']));
    stubFetch({
      'GET /api/verse/fleet/runs': { inbox: [] },
      'POST /api/verse/fleet/runs/inbox': () => json({ error: 'Inbox is full.' }, 400),
    });
    renderMobile(<MobileInterject />);
    const chips = within(screen.getByRole('group', { name: 'Recent messages' })).getAllByRole('button');
    expect(chips.map(chip => chip.textContent)).toEqual(['↑ six', '↑ five', '↑ four', '↑ three', '↑ two']);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsent order' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Inbox is full.');
    expect(loadHistory(localStorage)).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
  });
});
