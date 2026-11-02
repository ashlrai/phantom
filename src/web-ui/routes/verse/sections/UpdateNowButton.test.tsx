import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { UpdateNowButton } from './UpdateNowButton.js';
import { applySelfUpdate, type ApplyOutcome } from './update-apply-client.js';
import type { UpdateServerStatus } from './update-status-queries.js';
const show = vi.hoisted(() => vi.fn());
vi.mock('../../../components/primitives/Toast.js', () => ({ useToast: () => ({ show }) }));
vi.mock('./update-apply-client.js', () => ({ applySelfUpdate: vi.fn() }));
const status: UpdateServerStatus = { v: 1, sourceState: 'healthy', installedVersion: null, headSha: null, headAt: null, originSha: null, branch: 'master', behind: 3, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true };
beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });
it.each([{ ...status, behind: 0 }, { ...status, canFastForward: false }, { ...status, dirty: true }, { kind: 'notInBuild' } as const, undefined])('disables unavailable updates: %j', (value) => {
  render(<UpdateNowButton status={value} onDone={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();
});
it('posts once, announces the result, toasts and refreshes', async () => {
  let finish!: (outcome: ApplyOutcome) => void;
  vi.mocked(applySelfUpdate).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onDone = vi.fn();
  render(<UpdateNowButton status={status} onDone={onDone} />);
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
  expect(window.confirm).toHaveBeenCalledWith('Update Phantom to the newest commit now?');
  expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Updating…' }));
  finish({ kind: 'updated', toCommit: 'abcdef123', restart: 'manual' });
  const text = 'Updated to abcdef1. Quit and reopen Phantom to load it.';
  expect(await screen.findByText(text)).toHaveAttribute('aria-live', 'polite');
  expect(show).toHaveBeenCalledWith(text, 'success');
  expect(applySelfUpdate).toHaveBeenCalledOnce();
  await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
});
it('does not post when confirmation is cancelled', async () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  render(<UpdateNowButton status={status} onDone={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
  expect(applySelfUpdate).not.toHaveBeenCalled();
});
it.each(['already-current', 'busy', 'not-in-build', 'locked', 'refused', 'failed'] as const)('refreshes after %s', async (kind) => {
  vi.mocked(applySelfUpdate).mockResolvedValue(kind === 'refused' || kind === 'failed' ? { kind, reason: 'Unavailable' } : { kind });
  const onDone = vi.fn();
  render(<UpdateNowButton status={status} onDone={onDone} />);
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(show).toHaveBeenCalledOnce();
});
