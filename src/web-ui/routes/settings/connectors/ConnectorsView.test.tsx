import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorsSettings, ConnectorsView } from './ConnectorsView.js';
import { projectConnectors } from './connectors-client.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';

const token = 'synthetic-mutation-canary';
const secret = 'synthetic-credential-canary';
const capability = 'synthetic-capability-canary';
const revision = 'a'.repeat(40);
let enabled = true;
let failRead = false;
let failWrite = false;
let posts: unknown[];

beforeEach(() => {
  evictAll(); clearMutationToken(); enabled = true; failRead = false; failWrite = false; posts = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (failWrite) return new Response(JSON.stringify({ error: `${secret} ${capability}` }), { status: 409 });
      enabled = !enabled;
    }
    if (failRead) return new Response(JSON.stringify({ error: secret }), { status: 503 });
    return new Response(JSON.stringify({ revision, connectors: [{ name: 'locus', enabled, token: secret, capabilities: { command: capability } }], token: secret }));
  }));
});
afterEach(() => { evictAll(); clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('connector manager', () => {
  it('lists and gates mutations while locked', async () => {
    render(<ConnectorsView />);
    expect(await screen.findByRole('button', { name: 'Disable locus' })).toBeDisabled();
    expect(posts).toEqual([]);
  });

  it('confirms disable and enable, preserving a minimal request contract', async () => {
    setMutationToken(token);
    render(<ConnectorsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable locus' }));
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Disable locus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Updating…' }));
    await screen.findByRole('button', { name: 'Enable locus' });
    expect(posts).toEqual([{ name: 'locus', enabled: false, revision, confirm: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Enable locus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await screen.findByRole('button', { name: 'Disable locus' });
    expect(posts).toHaveLength(2);
  });

  it('never renders or logs tokens or capability values, including refusals and read errors', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    setMutationToken(token); failWrite = true;
    const { container } = render(<ConnectorsView />);
    const assertRedacted = () => {
      for (const canary of [token, secret, capability]) {
        expect(container.innerHTML).not.toContain(canary);
        expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(canary);
      }
    };
    const disable = await screen.findByRole('button', { name: 'Disable locus' });
    assertRedacted();
    fireEvent.click(disable);
    assertRedacted();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    assertRedacted();
    await screen.findByText('Connector change refused. Refresh and try again.');
    assertRedacted();
    failRead = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connectors' }));
    await screen.findByRole('alert');
    assertRedacted();
    expect(projectConnectors({ revision, connectors: [{ name: 'locus', enabled: true, token, capability }] })).toEqual({ revision, connectors: [{ name: 'locus', enabled: true }] });
  });

  it('handles malformed responses and recovers with refresh', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}'));
    render(<ConnectorsView />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connectors' }));
    await screen.findByRole('button', { name: 'Disable locus' });
  });

  it('shows a real empty state', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ revision, connectors: [] })));
    render(<ConnectorsView />);
    await waitFor(() => expect(screen.getByText('No Phantom gateway connectors configured.')).toBeInTheDocument());
  });
});

it('keeps the manager behind the agentWorkspace host flag', async () => {
  const { rerender } = render(<ConnectorsSettings />);
  expect(fetch).not.toHaveBeenCalled();
  Object.defineProperty(window, '__ASHLR_FEATURE_FLAGS__', { value: { agentWorkspace: true }, configurable: true });
  try {
    rerender(<ConnectorsSettings />);
    await screen.findByRole('button', { name: 'Disable locus' });
  } finally { Reflect.deleteProperty(window, '__ASHLR_FEATURE_FLAGS__'); }
});
