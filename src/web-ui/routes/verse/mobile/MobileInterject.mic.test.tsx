import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MobileInterject } from './MobileInterject.js';
import { MobileContext } from './mobile-context.js';
import { resetMobileToastsForTest } from './mobile-toast.js';
import { renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

class FakeRecognition {
  static current: FakeRecognition;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string }; length: number }> }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { FakeRecognition.current = this; }
}

function startDictation() {
  fireEvent.click(screen.getByRole('button', { name: 'Review browser dictation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
}

function recognize(transcript: string, isFinal: boolean) {
  act(() => FakeRecognition.current.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript }, length: 1 }] }));
}

beforeEach(() => {
  sessionStorage.clear();
  setMutationToken(TOKEN);
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
});
afterEach(() => {
  clearMutationToken();
  evictAll();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
});

describe('Tell the leaders dictation and reachability', () => {
  it('appends the final transcript and sends it through the inbox', async () => {
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': { inbox: [] },
      'POST /api/verse/fleet/runs/inbox': { ok: true, at: '2026-10-31T04:12:00Z' },
    });
    renderMobile(<MobileInterject />);
    const field = screen.getByRole('textbox', { name: 'Message to the leaders' });
    fireEvent.change(field, { target: { value: 'please' } });
    startDictation();
    recognize('ship it', true);
    act(() => FakeRecognition.current.onend?.());
    expect(field).toHaveValue('please ship it');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0].body).toEqual({ text: 'please ship it', source: 'Phantom mobile' });
  });

  it('shows interim speech but sends only committed text', async () => {
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': { inbox: [] },
      'POST /api/verse/fleet/runs/inbox': { ok: true, at: '2026-10-31T04:12:00Z' },
    });
    renderMobile(<MobileInterject />);
    const field = screen.getByRole('textbox', { name: 'Message to the leaders' });
    fireEvent.change(field, { target: { value: 'please' } });
    startDictation();
    recognize('ship it', false);
    expect(field).toHaveValue('please ship it');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0].body).toEqual({ text: 'please', source: 'Phantom mobile' });
  });

  it.each(['offline', 'unreachable'] as const)('preserves the draft while %s and enables send after reconnecting', (reachability) => {
    const stub = stubFetch({ 'GET /api/verse/fleet/runs': { inbox: [] } });
    const view = renderMobile(<MobileInterject />, { reachability });
    const field = screen.getByRole('textbox', { name: 'Message to the leaders' });
    fireEvent.change(field, { target: { value: 'Keep this note' } });
    expect(screen.getByText("Can't reach your Mac — your note stays here until it reconnects")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Review browser dictation' })).toBeDisabled();
    fireEvent.submit(field.closest('form')!);
    expect(stub.posts()).toHaveLength(0);
    view.rerender(<MobileContext.Provider value={{ ...view.context, reachability: 'live' }}><MobileInterject /></MobileContext.Provider>);
    expect(field).toHaveValue('Keep this note');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.queryByText("Can't reach your Mac — your note stays here until it reconnects")).not.toBeInTheDocument();
  });
});
