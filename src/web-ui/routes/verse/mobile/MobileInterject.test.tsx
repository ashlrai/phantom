import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MobileInterject } from './MobileInterject.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

const at = '2026-09-27T12:52:00Z';
const entry = { at, source: 'Phantom mobile', text: 'A message' };

beforeEach(() => setMutationToken(TOKEN));
afterEach(() => {
  clearMutationToken();
  evictAll();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
});

describe('Tell the leaders', () => {
  it('sends with the mutation token, confirms, and refreshes the tail', async () => {
    let sent = false;
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': () => ({ inbox: sent ? [entry, { ...entry, text: 'Earlier' }] : [{ ...entry, text: 'Earlier' }] }),
      'POST /api/verse/fleet/runs/inbox': () => { sent = true; return { ok: true, at }; },
    });
    renderMobile(<><MobileInterject /><MobileToasts /></>);
    expect(await screen.findByText('Earlier')).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Message to the leaders' });
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toBeDisabled();
    expect(field).toHaveAttribute('maxLength', '6000');
    fireEvent.change(field, { target: { value: ' A message ' } });
    fireEvent.click(button);
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0]).toMatchObject({ body: { text: 'A message', source: 'Phantom mobile' }, headers: { 'x-ashlr-token': TOKEN } });
    expect(await screen.findByText('A message')).toBeInTheDocument();
    expect(screen.getByText(/^Landed /)).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(stub.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('shows at most three entries without the field in read-only mode', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { inbox: [entry, ...['two', 'three', 'four'].map((text) => ({ ...entry, text }))] } });
    renderMobile(<MobileInterject />, { permissions: permissionsFor('unavailable') });
    expect(await screen.findByText('A message')).toBeInTheDocument();
    expect(screen.getByText('three')).toBeInTheDocument();
    expect(screen.queryByText('four')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps text and shows the server reason when a send fails', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { inbox: [] }, 'POST /api/verse/fleet/runs/inbox': () => json({ error: 'Inbox is full.' }, 400) });
    renderMobile(<MobileInterject />);
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'Keep this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Inbox is full.');
    expect(field).toHaveValue('Keep this');
  });

  it('hides the field when the fleet runs route is absent', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': () => json({ error: 'not found' }, 404) });
    renderMobile(<MobileInterject />);
    expect(await screen.findByText('This build has no fleet inbox yet.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
