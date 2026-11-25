import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NativeComputer } from '../computer/native-computer.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import { setVerseSection } from '../verse-ui-store.js';
import FullPermissionsSetup, { PermissionsGuide } from './FullPermissionsSetup.js';

vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ status: 'error' }), useRefetch: () => vi.fn() }));
vi.mock('../autonomy/AutonomyOffState.js', () => ({ authoritySetupQuery: {}, CopyCommand: ({ command }: { command: string }) => <code>{command}</code> }));
vi.mock('../usage/CapacityStrip.js', () => ({ LiveCapacityStrip: () => <p>Agent connection status</p> }));
vi.mock('../shell/run-command.js', () => ({ executeCatalogCommand: vi.fn() }));
vi.mock('../verse-ui-store.js', () => ({ setVerseSection: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function bridge(data: unknown = { screen: true, accessibility: false }): NativeComputer {
  return {
    version: 1,
    request: vi.fn<NativeComputer['request']>(async (op) => ({ kind: 'result', req: op.req, ok: true, data })),
    send: vi.fn(() => true),
    onState: () => () => undefined,
  };
}

describe('full permissions onboarding', () => {
  it('starts closed and never opens authority on its own', () => {
    render(<FullPermissionsSetup />);
    expect(screen.getByRole('button', { name: 'Review permissions' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('1. macOS permissions')).not.toBeInTheDocument();
    expect(executeCatalogCommand).not.toHaveBeenCalled();
  });

  it('reads status without prompting and distinguishes manual review from granted', async () => {
    const native = bridge();
    render(<PermissionsGuide bridge={native} />);
    await screen.findByText('Screen Recording: Granted');
    expect(screen.getByText('Full Disk Access: Needs review')).toBeInTheDocument();
    expect(screen.getByText('Developer Tools: Needs review')).toBeInTheDocument();
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(native.send).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Request Screen Recording' })).not.toBeInTheDocument();
  });

  it('rechecks before prompting and suppresses a grant acquired since the last read', async () => {
    const native = bridge();
    render(<PermissionsGuide bridge={native} />);
    await screen.findByText('Accessibility: Missing');
    vi.mocked(native.request).mockResolvedValue({ kind: 'result', req: 'r', ok: true, data: { screen: true, accessibility: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Request Accessibility' }));
    await screen.findByText('Accessibility: Granted');
    expect(vi.mocked(native.request).mock.calls.every(([op]) => op.op === 'permissions')).toBe(true);
  });

  it('requests only the selected missing permission after explicit action', async () => {
    const native = bridge();
    render(<PermissionsGuide bridge={native} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Request Accessibility' }));
    await waitFor(() => expect(native.request).toHaveBeenCalledTimes(3));
    expect(native.request).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'request-permission', kind: 'accessibility' }));
    expect(native.send).not.toHaveBeenCalled();
  });

  it('opens only the named fixed Settings pane for manual permissions', async () => {
    const native = bridge();
    render(<PermissionsGuide bridge={native} />);
    await screen.findByText('Accessibility: Missing');
    await userEvent.click(screen.getByRole('button', { name: 'Review Full Disk Access' }));
    expect(native.send).toHaveBeenCalledWith({ op: 'open-settings', kind: 'full-disk-access' });
    expect(native.request).toHaveBeenCalledTimes(1);
  });

  it('clears stale grants when the next read fails', async () => {
    const native = bridge();
    render(<PermissionsGuide bridge={native} />);
    await screen.findByText('Screen Recording: Granted');
    vi.mocked(native.request).mockResolvedValue({ kind: 'result', req: 'r', ok: false, code: 'timeout', error: 'Timed out' });
    await userEvent.click(screen.getByRole('button', { name: 'Check permissions again' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Screen Recording: Needs review')).toBeInTheDocument();
    expect(screen.queryByText('Screen Recording: Granted')).not.toBeInTheDocument();
  });

  it('routes an explicitly selected authority level through the existing grant flow', async () => {
    render(<PermissionsGuide bridge={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Your authority level' }), 'propose');
    expect(executeCatalogCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Set authority to Propose' }));
    expect(executeCatalogCommand).toHaveBeenCalledWith('autonomy.propose', { via: 'button' });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Agent connection status')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect agents in Apps & Accounts' }));
    expect(setVerseSection).toHaveBeenCalledWith('apps');
  });

  it('keeps browser observations unknown and disables native actions', () => {
    render(<PermissionsGuide bridge={null} />);
    expect(screen.getByText('Screen Recording: Needs review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check permissions again' })).toBeDisabled();
  });
});
