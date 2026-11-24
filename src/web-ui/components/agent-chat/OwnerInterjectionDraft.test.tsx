import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OwnerInterjectionDraft } from './OwnerInterjectionDraft.js';
import { prepareOwnerDraft } from './owner-interjection-draft.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function clipboard(write = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal('navigator', { clipboard: { writeText: write } }); return write;
}
function show() { return render(<OwnerInterjectionDraft channel="engineering" thread="run:one" />); }
const note = (text: string) => fireEvent.change(screen.getByLabelText('Your note'), { target: { value: text } });
describe('owner note preparation only', () => {
  it('creates exact schema with original text and no sender/authority fields', () => {
    const draft = prepareOwnerDraft('engineering', 'run:one', '  Review\n<test>  ');
    expect(draft.ok && JSON.parse(draft.json)).toEqual({ kind: 'agent-chat.share', channel: 'engineering', thread: 'run:one', text: '  Review\n<test>  ' });
  });
  it.each([['../bad', 'run:one', 'hello'], ['engineering\n', 'run:one', 'hello'], ['engineering', 'run:one\n', 'hello'], ['engineering', 'other', 'hello'], ['engineering', 'run:one', ' '], ['engineering', 'run:one', '\\'.repeat(4000)]])('rejects malformed/empty/JSON-oversize draft', (channel, thread, text) => {
    expect(prepareOwnerDraft(channel!, thread!, text!).ok).toBe(false);
  });
  it('rejects decoded credential-shaped content before copy', () => {
    const secret = String.fromCharCode(115, 107, 45) + 'a'.repeat(48);
    expect(prepareOwnerDraft('engineering', 'run:one', secret).ok).toBe(false);
    const write = clipboard(); show(); note(secret);
    expect(screen.getByRole('button', { name: 'Copy draft JSON' })).toBeDisabled();
    expect(write).not.toHaveBeenCalled();
  });
  it('copies only on click, never sends or persists, and invalidates copied state on edit', async () => {
    const write = clipboard(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const storage = vi.spyOn(Storage.prototype, 'setItem'); show(); note('Review tests');
    expect(write).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Copy draft JSON' }));
    await screen.findByText('Copied, not sent. A native receipt is required to confirm sharing.');
    expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({ channel: 'engineering', thread: 'run:one', text: 'Review tests' });
    expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
    note('Changed'); expect(screen.queryByText(/Copied, not sent/)).toBeNull();
  });
  it('clears draft on scope change and ignores late clipboard completion', async () => {
    let resolve!: () => void; clipboard(vi.fn(() => new Promise<void>(done => { resolve = done; })));
    const view = show(); note('Old private draft'); fireEvent.click(screen.getByRole('button', { name: 'Copy draft JSON' }));
    view.rerender(<OwnerInterjectionDraft channel="engineering" thread="outcome:two" />);
    expect(screen.getByLabelText('Your note')).toHaveValue(''); resolve();
    await waitFor(() => expect(screen.queryByText(/Copied, not sent/)).toBeNull());
  });
  it('reports clipboard denial without claiming send or success; retry is explicit', async () => {
    const write = clipboard(vi.fn().mockRejectedValue(new Error('denied'))); show(); note('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Copy draft JSON' }));
    await screen.findByText('Could not copy. Nothing was sent; review and copy the JSON manually.');
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('renders hostile text as text, clears locally, and never attaches history', () => {
    clipboard(); const view = show(); note('<img src=x onerror=alert(1)>');
    expect(view.container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear draft' })); expect(screen.getByLabelText('Your note')).toHaveValue('');
    expect(screen.getByText(/availability is unverified/)).toBeInTheDocument();
  });
});
