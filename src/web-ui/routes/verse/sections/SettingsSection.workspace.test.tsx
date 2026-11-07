import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFeatureFlag, setFeatureFlag, useFeatureFlag } from '../../../app/desktop-state.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, getMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { FEATURE_FLAGS_STORAGE_KEY, resetFeatureFlagsForTests } from '../../../data/feature-flags.js';
import { SettingsSection } from './SettingsSection.js';

function WorkspaceConsumer() {
  return useFeatureFlag('agentWorkspace') ? <div>Workspace feature fixture</div> : null;
}

function renderSettings() {
  return render(<ToastProvider><SettingsSection /><WorkspaceConsumer /></ToastProvider>);
}

beforeEach(() => {
  localStorage.clear();
  resetFeatureFlagsForTests();
  clearMutationToken();
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearMutationToken();
  localStorage.clear();
  resetFeatureFlagsForTests();
});

describe('Settings agent workspace opt-in', () => {
  it('defaults off and leaves gated UI absent', () => {
    renderSettings();
    expect(screen.getByRole('switch', { name: 'Agent workspace' })).not.toBeChecked();
    expect(screen.queryByText('Workspace feature fixture')).not.toBeInTheDocument();
    expect(getFeatureFlag('agentWorkspace')).toBe(false);
  });

  it('toggles on and off by keyboard, updates readers live and survives remount/reload', async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    const toggle = screen.getByRole('switch', { name: 'Agent workspace' });
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toBeChecked();
    expect(screen.getByText('Workspace feature fixture')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)!)).toEqual({ agentWorkspace: true, oneAsk: false });
    view.unmount();
    resetFeatureFlagsForTests();
    renderSettings();
    const restored = screen.getByRole('switch', { name: 'Agent workspace' });
    expect(restored).toBeChecked();
    await user.click(restored);
    expect(restored).not.toBeChecked();
    expect(screen.queryByText('Workspace feature fixture')).not.toBeInTheDocument();
    expect(getMutationToken()).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // This local preference never makes a server mutation.
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('reflects programmatic changes without remounting Settings', () => {
    renderSettings();
    act(() => setFeatureFlag('agentWorkspace', true));
    expect(screen.getByRole('switch', { name: 'Agent workspace' })).toBeChecked();
    act(() => setFeatureFlag('agentWorkspace', false));
    expect(screen.getByRole('switch', { name: 'Agent workspace' })).not.toBeChecked();
  });

  it('never renders or logs secret, token or capability values from stored flags', async () => {
    const sentinels = ['workspace-secret-sentinel', 'f'.repeat(64), 'workspace-capability-sentinel'];
    localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({
      agentWorkspace: true, secret: sentinels[0], token: sentinels[1], capability: sentinels[2],
    }));
    setMutationToken(sentinels[1]!);
    const logs = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = logs.map((method) => vi.spyOn(console, method));
    const user = userEvent.setup();
    const { container } = renderSettings();
    expect(screen.getByRole('switch', { name: 'Agent workspace' })).toBeChecked();
    const assertRedacted = () => {
      for (const value of sentinels) {
        expect(container.innerHTML).not.toContain(value);
        expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(value);
      }
    };
    assertRedacted();
    await user.click(screen.getByRole('switch', { name: 'Agent workspace' }));
    assertRedacted();
    expect(localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY)).toBe('{"agentWorkspace":false,"oneAsk":false}');
    expect(getMutationToken()).toBe(sentinels[1]);
  });
});
