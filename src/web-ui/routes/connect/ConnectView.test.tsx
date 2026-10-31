import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOURCE_CATALOG } from '../../../core/onboard/catalog.js';
import type { OnboardResourceStatus, OnboardStatusReport } from '../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { ConnectView } from './ConnectView.js';

function resourceStatus(overrides: Partial<OnboardResourceStatus> = {}): OnboardResourceStatus {
  return {
    id: 'codex', installed: true, binaryPath: '/bin/codex',
    loginState: 'logged-out', loginCommand: 'codex login', selectedPlanTier: null, ...overrides,
  };
}

function report(overrides: Partial<OnboardStatusReport> = {}): OnboardStatusReport {
  return {
    generatedAt: '2026-10-28T00:00:00.000Z', dispatchEnabled: true,
    resources: [resourceStatus()], ...overrides,
  };
}

function stubApi(status = 200, body: unknown = report(), posts: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push({ path, body: init.body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify(body), { status });
  }));
}

beforeEach(() => setMutationToken('a'.repeat(64)));
afterEach(() => { clearMutationToken(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Connect Resources', () => {
  // First render in the file pays the jsdom + role-query warm-up cost.
  it('renders every catalog entry in its step with accessible documentation links', { timeout: 15_000 }, async () => {
    stubApi();
    render(<ConnectView />);
    const titles = ['Subscriptions', 'API keys', 'Local models', 'This computer', 'Cloud computer', 'Proactive agents'];
    const kinds = ['subscription', 'apikey', 'local', 'computer', 'cloud', 'agent'];
    titles.forEach((title, index) => {
      const section = screen.getByRole('region', { name: title });
      for (const resource of RESOURCE_CATALOG.filter((item) => item.kind === kinds[index])) {
        expect(within(section).getByRole('link', { name: resource.displayName })).toHaveAttribute('href', resource.docsUrl);
      }
    });
    expect(await screen.findAllByRole('combobox')).not.toHaveLength(0);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has unique ids and safe descriptive metadata', () => {
    expect(new Set(RESOURCE_CATALOG.map((item) => item.id)).size).toBe(RESOURCE_CATALOG.length);
    expect(RESOURCE_CATALOG.filter((item) => item.kind === 'apikey').every((item) => item.keyEnvName && item.validateEndpoint?.startsWith('https://'))).toBe(true);
  });

  it('shows detection status and guided login, then persists a plan-tier pick', async () => {
    const posts: unknown[] = [];
    stubApi(200, report({ resources: [resourceStatus({ selectedPlanTier: 'Pro' })] }), posts);
    render(<ConnectView />);
    const section = screen.getByRole('region', { name: 'Subscriptions' });
    expect(await within(section).findByText('Installed - not signed in')).toBeInTheDocument();
    expect(within(section).getByText('codex login')).toBeInTheDocument();
    const picker = within(section).getByRole('combobox', { name: 'Codex plan tier' });
    expect(picker).toHaveValue('Pro');
    fireEvent.change(picker, { target: { value: 'Plus' } });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ path: '/api/onboard/plan-tier', body: JSON.stringify({ resourceId: 'codex', planTier: 'Plus' }) });
  });

  it('locks the picker when dispatch is off and says when detection is down', async () => {
    stubApi(200, report({ dispatchEnabled: false }));
    const { unmount } = render(<ConnectView />);
    expect(await screen.findByRole('combobox', { name: 'Codex plan tier' })).toBeDisabled();
    unmount();
    stubApi(503);
    render(<ConnectView />);
    expect(await screen.findByRole('status')).toHaveTextContent('Live detection is unavailable.');
  });
});
