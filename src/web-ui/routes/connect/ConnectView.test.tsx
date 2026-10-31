import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESOURCE_CATALOG } from '../../../core/onboard/catalog.js';
import type { OnboardComputerStatus, OnboardResourceStatus, OnboardStatusReport } from '../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { ConnectView } from './ConnectView.js';

function resourceStatus(overrides: Partial<OnboardResourceStatus> = {}): OnboardResourceStatus {
  return {
    id: 'codex', installed: true, binaryPath: '/bin/codex',
    loginState: 'logged-out', loginCommand: 'codex login', selectedPlanTier: null, ...overrides,
  };
}

function computerStatus(overrides: Partial<OnboardComputerStatus> = {}): OnboardComputerStatus {
  return {
    paired: false, pairedAt: null, lastSeenAt: null,
    serviceInstalled: false, serviceActivity: 'inactive', daemonRunning: false,
    enrolledRepos: 0, ...overrides,
  };
}

function report(overrides: Partial<OnboardStatusReport> = {}): OnboardStatusReport {
  return {
    generatedAt: '2026-10-28T00:00:00.000Z', dispatchEnabled: true,
    resources: [resourceStatus()], computer: computerStatus(), ...overrides,
  };
}

function stubApi(status = 200, body: unknown = report(), posts: Array<{ path: string; body: string | undefined }> = [], postBody?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push({ path, body: init.body === undefined ? undefined : String(init.body) });
      return new Response(JSON.stringify(postBody ?? { ok: true }), { status: 200 });
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
    expect(await screen.findByRole('button', { name: 'Pair this computer' })).toBeInTheDocument();
  });

  it('has unique ids and safe descriptive metadata', () => {
    expect(new Set(RESOURCE_CATALOG.map((item) => item.id)).size).toBe(RESOURCE_CATALOG.length);
    expect(RESOURCE_CATALOG.filter((item) => item.kind === 'apikey').every((item) => item.keyEnvName && item.validateEndpoint?.startsWith('https://'))).toBe(true);
  });

  it('shows detection status and guided login, then persists a plan-tier pick', async () => {
    const posts: Array<{ path: string; body: string | undefined }> = [];
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

  it('locks the picker and pairing when dispatch is off and says when detection is down', async () => {
    stubApi(200, report({ dispatchEnabled: false }));
    const { unmount } = render(<ConnectView />);
    expect(await screen.findByRole('combobox', { name: 'Codex plan tier' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Pair this computer' })).toBeDisabled();
    unmount();
    stubApi(503);
    render(<ConnectView />);
    expect(await screen.findByRole('status')).toHaveTextContent('Live detection is unavailable.');
  });
});

describe('This computer pairing', () => {
  it('shows pairing status, pair date and last-seen, then unpairs', async () => {
    const posts: Array<{ path: string; body: string | undefined }> = [];
    stubApi(200, report({
      computer: computerStatus({
        paired: true, pairedAt: '2026-10-01T12:00:00.000Z', lastSeenAt: '2026-10-28T00:00:00.000Z',
        serviceInstalled: true, serviceActivity: 'running', daemonRunning: true, enrolledRepos: 3,
      }),
    }), posts, { ok: true, computer: computerStatus({ paired: false }), steps: [] });
    render(<ConnectView />);
    const section = screen.getByRole('region', { name: 'This computer' });
    expect(await within(section).findByText(/Paired · daemon running · 3 repo\(s\) enrolled/)).toBeInTheDocument();
    expect(within(section).getByText(/^Paired \d/)).toBeInTheDocument();
    expect(within(section).getByText(/^Last seen \d/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Unpair' }));
    await vi.waitFor(() => expect(posts.some((p) => p.path === '/api/onboard/unpair')).toBe(true));
  });

  it('posts /api/onboard/pair and surfaces a refused pair result', async () => {
    const posts: Array<{ path: string; body: string | undefined }> = [];
    stubApi(200, report(), posts, {
      ok: false, computer: computerStatus(),
      steps: [{ name: 'daemon-service', status: 'manual', detail: 'service authority unavailable' }],
    });
    render(<ConnectView />);
    const section = screen.getByRole('region', { name: 'This computer' });
    expect(await within(section).findByText(/Not paired · daemon service not installed/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Pair this computer' }));
    await vi.waitFor(() => expect(posts.some((p) => p.path === '/api/onboard/pair' && p.body === '{}')).toBe(true));
    expect(await within(section).findByRole('alert')).toHaveTextContent('service authority unavailable');
  });
});
