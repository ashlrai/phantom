import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerseNativeSessionBinding } from '../../../../core/verse/native-session-binding-types.js';
import { ApiError } from '../../../data/client.js';
import { NativeConversationSheet } from './NativeConversationSheet.js';
import type { NativeBindingApi } from './native-binding-client.js';
import { binding } from './native-binding.test-support.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const initialClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
function clipboard(value: unknown) { Object.defineProperty(navigator, 'clipboard', { configurable: true, value }); }
afterEach(() => {
  vi.unstubAllGlobals();
  if (initialClipboard) Object.defineProperty(navigator, 'clipboard', initialClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('NativeConversationSheet', () => {
  it('fetches only when opened and distinguishes saved running state from unverified live connections', async () => {
    const read = vi.fn(async () => binding()); const api = { read }; const onClose = vi.fn();
    const view = render(<NativeConversationSheet sessionId="vs_1" open={false} onClose={onClose} api={api} />);
    expect(read).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<NativeConversationSheet sessionId="vs_1" open onClose={onClose} api={api} />);
    expect(await screen.findByText('conversation_1')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Native conversation' })).toBeInTheDocument();
    expect(screen.getByText('Running when last saved')).toBeInTheDocument();
    expect(screen.getAllByText('Unverified')).toHaveLength(2);
    expect(screen.getByText(/do not establish a live connection/)).toBeInTheDocument();
    expect(screen.queryByText('codex-main')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open.*desktop/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copies only the recorded native conversation ID', async () => {
    const writeText = vi.fn(async () => {}); clipboard({ writeText });
    render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={{ read: async () => binding() }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy conversation ID' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument(); expect(writeText).toHaveBeenCalledWith('conversation_1');
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'rejected'])('handles %s clipboard without claiming success', async mode => {
    clipboard(mode === 'missing' ? undefined : { writeText: vi.fn(async () => { throw Error('/private/clipboard'); }) });
    render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={{ read: async () => binding() }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy conversation ID' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t copy. Select the conversation ID and copy it manually.');
    expect(screen.queryByText('Copied')).toBeNull(); expect(document.body.textContent).not.toContain('/private');
  });

  it.each([
    binding({ nativeIdState: 'not-created', nativeSessionId: null }),
    binding({ nativeIdState: 'invalid', nativeSessionId: null }),
    binding({ engine: 'local', nativeIdState: 'unsupported', nativeSessionId: null }),
  ])('shows unavailable ID state $nativeIdState without a copy action', async metadata => {
    render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={{ read: async () => metadata }} />);
    await screen.findByText('Saved Phantom metadata');
    expect(screen.queryByRole('button', { name: 'Copy conversation ID' })).toBeNull();
    expect(screen.queryByText('conversation_1')).toBeNull();
  });

  it('aborts on selection change and ignores a late reader that does not honor cancellation', async () => {
    const old = deferred<VerseNativeSessionBinding>(); const next = deferred<VerseNativeSessionBinding>();
    const signals: AbortSignal[] = [];
    const api: NativeBindingApi = { read: vi.fn((id, signal) => { signals.push(signal); return id === 'vs_1' ? old.promise : next.promise; }) };
    const view = render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={api} />);
    view.rerender(<NativeConversationSheet sessionId="vs_2" open onClose={() => {}} api={api} />);
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => old.resolve(binding())); expect(screen.queryByText('conversation_1')).toBeNull();
    expect(screen.getByText('Loading saved conversation…')).toBeInTheDocument();
    await act(async () => next.resolve(binding({ sessionId: 'vs_2', nativeSessionId: 'conversation_2' })));
    expect(screen.getByText('conversation_2')).toBeInTheDocument(); expect(screen.queryByText('conversation_1')).toBeNull();
  });

  it('hides already loaded data immediately when the selected chat changes', async () => {
    const next = deferred<VerseNativeSessionBinding>();
    const api: NativeBindingApi = { read: async id => id === 'vs_1' ? binding() : next.promise };
    const view = render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={api} />);
    await screen.findByText('conversation_1');
    view.rerender(<NativeConversationSheet sessionId="vs_2" open onClose={() => {}} api={api} />);
    expect(screen.queryByText('conversation_1')).toBeNull(); expect(screen.getByText('Loading saved conversation…')).toBeInTheDocument();
    view.unmount();
  });

  it.each(['close', 'unmount'])('aborts the request on %s and ignores late completion', async mode => {
    const pending = deferred<VerseNativeSessionBinding>(); let signal!: AbortSignal;
    const api: NativeBindingApi = { read: async (_id, abort) => { signal = abort; return pending.promise; } };
    const view = render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={api} />);
    if (mode === 'close') view.rerender(<NativeConversationSheet sessionId="vs_1" open={false} onClose={() => {}} api={api} />);
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(binding()));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('conversation_1')).toBeNull();
  });

  it('does not announce a previous chat’s pending clipboard completion in a newly selected chat', async () => {
    const copied = deferred<void>(); clipboard({ writeText: () => copied.promise });
    const api: NativeBindingApi = { read: async id => binding({ sessionId: id, nativeSessionId: `conversation_${id}` }) };
    const view = render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy conversation ID' }));
    view.rerender(<NativeConversationSheet sessionId="vs_2" open onClose={() => {}} api={api} />);
    await screen.findByText('conversation_vs_2'); await act(async () => copied.resolve());
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('shows fixed auth error copy and supports an explicit retry', async () => {
    const read = vi.fn().mockRejectedValueOnce(new ApiError('/private/server', 401, '/private', '/private/account')).mockResolvedValueOnce(binding());
    render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} api={{ read }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Read session expired. Reconnect Phantom to try again.');
    expect(document.body.textContent).not.toContain('/private');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('conversation_1'); expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects malformed responses through the real read client without displaying private fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...binding(), accountPath: '/private/account' }))));
    render(<NativeConversationSheet sessionId="vs_1" open onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Conversation details could not be loaded. Try again.');
    expect(document.body.textContent).not.toContain('/private'); expect(screen.queryByText('conversation_1')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy conversation ID' })).toBeNull());
  });
});
