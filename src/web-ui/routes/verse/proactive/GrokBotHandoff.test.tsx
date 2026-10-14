import { createHash } from 'node:crypto';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { GrokBotHandoff, type GrokBotHandoffProps } from './GrokBotHandoff.js';
import { fetchGrokBotHandoffPreview, type GrokBotHandoffPreview } from './proactive-queries.js';

vi.mock('./proactive-queries.js', async original => ({ ...await original<typeof import('./proactive-queries.js')>(), fetchGrokBotHandoffPreview: vi.fn() }));
const fetchPreview = vi.mocked(fetchGrokBotHandoffPreview);
const clipboard = vi.fn<(text: string) => Promise<void>>();
const request = { taskId: 'ct_' + 'a'.repeat(32), attemptId: 'b'.repeat(64), epoch: 1, expectedRevision: 4,
  profileId: 'pa_' + 'c'.repeat(24), expectedProfileVersion: 2 };
const packetDigest = 'd'.repeat(64);
function preview(text = 'Manual copy is not provider acceptance or completion.\n{"goal":"Review the exact PR"}', over: Partial<GrokBotHandoffPreview> = {}): GrokBotHandoffPreview {
  return { schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, epoch: request.epoch,
    revision: request.expectedRevision, profileId: request.profileId, profileVersion: request.expectedProfileVersion,
    packetDigest, previewDigest: createHash('sha256').update(text).digest('hex'), briefText: text,
    dispatchAuthorized: false, contextShared: false, transport: 'manual-copy', ...over };
}
function props(over: Partial<GrokBotHandoffProps> = {}): GrokBotHandoffProps {
  return { request, packetDigest, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), deadline: null,
    disabled: false, onClose: vi.fn(), ...over };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { setMutationToken(TEST_TOKEN); fetchPreview.mockReset(); fetchPreview.mockResolvedValue(preview()); clipboard.mockReset(); clipboard.mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } }); });
afterEach(() => { clearMutationToken(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function review() { await screen.findByLabelText('Grok Bot brief'); fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this exact brief/ })); }

describe('manual Grok Bot brief review', () => {
  it('requires exact review then fresh server recheck before copying, without claiming dispatch', async () => {
    const initial = props(); render(<GrokBotHandoff {...initial} />);
    expect(screen.getByRole('button', { name: 'Recheck and copy brief' })).toBeDisabled();
    await review(); fireEvent.click(screen.getByRole('button', { name: 'Recheck and copy brief' }));
    await screen.findByText(/Brief copied\. Paste it into the intended Grok Bot yourself/);
    expect(fetchPreview).toHaveBeenCalledTimes(2);
    expect(fetchPreview.mock.calls[1]?.[0]).toEqual({ ...request, expectedPreviewDigest: preview().previewDigest });
    expect(clipboard).toHaveBeenCalledOnce(); expect(clipboard).toHaveBeenCalledWith(preview().briefText);
    expect(screen.getByText(/Copying does not contact Grok Bot/)).toBeVisible();
  });
  it('requires a mutation-token unlock before any preview request', async () => {
    clearMutationToken(); render(<GrokBotHandoff {...props()} />);
    await screen.findByRole('dialog', { name: 'Unlock actions' }); expect(fetchPreview).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Mutation token'), { target: { value: TEST_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByLabelText('Grok Bot brief'); expect(fetchPreview).toHaveBeenCalledOnce();
  });
  it('does not copy a changed recheck and clears the old reviewed selection', async () => {
    render(<GrokBotHandoff {...props()} />); await review();
    fetchPreview.mockResolvedValueOnce(preview('Different current recipient or work scope.'));
    fireEvent.click(screen.getByRole('button', { name: 'Recheck and copy brief' }));
    await screen.findByRole('alert'); expect(clipboard).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Grok Bot brief')).not.toBeInTheDocument();
  });
  it.each(['missing', 'rejected'])('shows selectable freshly rechecked text when clipboard is %s, without a copied claim', async mode => {
    if (mode === 'missing') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    else clipboard.mockRejectedValue(new Error('clipboard permission refused'));
    render(<GrokBotHandoff {...props()} />); await review(); fireEvent.click(screen.getByRole('button', { name: 'Recheck and copy brief' }));
    const fallback = await screen.findByLabelText('Rechecked brief for manual copy'); expect(fallback).toHaveValue(preview().briefText);
    expect(screen.getByText(/Clipboard unavailable/)).toBeVisible(); expect(screen.queryByText(/Brief copied\./)).not.toBeInTheDocument();
    expect(fetchPreview).toHaveBeenCalledTimes(2);
  });
  it('ignores a late preview after close, including a fetch that ignores abort', async () => {
    const pending = deferred<GrokBotHandoffPreview>(); fetchPreview.mockReturnValueOnce(pending.promise);
    const close = vi.fn(); const view = render(<GrokBotHandoff {...props({ onClose: close })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); view.unmount();
    await act(async () => pending.resolve(preview()));
    expect(close).toHaveBeenCalledOnce(); expect(fetchPreview.mock.calls[0]?.[2].aborted).toBe(true);
    expect(clipboard).not.toHaveBeenCalled();
  });
  it.each(['revision', 'profile'])('hides a delayed old result after %s changes', async mode => {
    const pending = deferred<GrokBotHandoffPreview>(); fetchPreview.mockReturnValueOnce(pending.promise);
    const initial = props(); const view = render(<GrokBotHandoff {...initial} />);
    const next = { ...request, ...(mode === 'revision' ? { expectedRevision: 5 } : { expectedProfileVersion: 3 }) };
    fetchPreview.mockResolvedValueOnce(preview('Current binding only.', { revision: next.expectedRevision, profileVersion: next.expectedProfileVersion }));
    view.rerender(<GrokBotHandoff {...initial} request={next} />); await screen.findByText('Current binding only.');
    await act(async () => pending.resolve(preview()));
    expect(screen.queryByText(preview().briefText)).not.toBeInTheDocument(); expect(clipboard).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
  it('blocks a cancellation/availability change while a copy recheck is pending', async () => {
    const initial = props(); const view = render(<GrokBotHandoff {...initial} />); await review();
    const pending = deferred<GrokBotHandoffPreview>(); fetchPreview.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck and copy brief' }));
    view.rerender(<GrokBotHandoff {...initial} disabled />);
    await act(async () => pending.resolve(preview()));
    expect(clipboard).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Recheck and copy brief' })).toBeDisabled();
  });
  it.each(['clear', 'rotate'])('does not copy when action authority is %s while recheck is pending', async mode => {
    render(<GrokBotHandoff {...props()} />); await review();
    const pending = deferred<GrokBotHandoffPreview>(); fetchPreview.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck and copy brief' }));
    await act(async () => { if (mode === 'clear') clearMutationToken(); else setMutationToken('e'.repeat(64)); pending.resolve(preview()); });
    expect(clipboard).not.toHaveBeenCalled(); expect(screen.queryByText(/Brief copied\./)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recheck and copy brief' })).toBeDisabled();
  });
  it('blocks lease expiry while the server recheck is pending', async () => {
    vi.useFakeTimers(); const initial = props({ leaseExpiresAt: new Date(Date.now() + 25).toISOString() });
    await act(async () => { render(<GrokBotHandoff {...initial} />); });
    fireEvent.click(screen.getByRole('checkbox')); const pending = deferred<GrokBotHandoffPreview>(); fetchPreview.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Recheck and copy brief' }));
    await act(async () => { vi.advanceTimersByTime(26); pending.resolve(preview()); });
    expect(clipboard).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('no longer current');
  });
});
