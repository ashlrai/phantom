import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiKeyCatalogResources, RESOURCE_CATALOG } from '../../../core/onboard/catalog.js';
import { ConnectView } from './ConnectView.js';
import { evictAll } from '../../data/cache.js';
import { setMutationToken, clearMutationToken } from '../../data/auth-store.js';

const KEYS = apiKeyCatalogResources().map((r) => ({
  resource: r.id,
  envName: r.keyEnvName,
  displayName: r.displayName,
  stored: false,
}));

// Deliberately not secret-shaped: if this value ever rendered, it was echoed raw.
const KEY_VALUE = 'fakekey_probe_NOTASECRET_13579';
const KEY_LAST4 = KEY_VALUE.slice(-4);
const TOKEN = 'a'.repeat(64);

function stubFetch(posted: Record<string, unknown>[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/connect/key' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        ok: true,
        resource: 'openai',
        envName: 'OPENAI_API_KEY',
        masked: `****${KEY_LAST4}`,
        stored: true,
        validated: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/connect/keys') {
      return new Response(JSON.stringify({ keys: KEYS }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('Connect Resources', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    clearMutationToken();
    document.head.querySelectorAll('meta[name="ashlr-remote-gateway"]').forEach((m) => m.remove());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders every catalog entry in its step with accessible documentation links', () => {
    vi.stubGlobal('fetch', stubFetch([]));
    render(<ConnectView />);
    const titles = ['Subscriptions', 'API keys', 'Local models', 'This computer', 'Cloud computer', 'Proactive agents'];
    const kinds = ['subscription', 'apikey', 'local', 'computer', 'cloud', 'agent'];
    titles.forEach((title, index) => {
      const section = screen.getByRole('region', { name: title });
      for (const resource of RESOURCE_CATALOG.filter((item) => item.kind === kinds[index])) {
        expect(within(section).getByRole('link', { name: resource.displayName })).toHaveAttribute('href', resource.docsUrl);
      }
    });
  });

  it('has unique ids and safe descriptive metadata', () => {
    expect(new Set(RESOURCE_CATALOG.map((item) => item.id)).size).toBe(RESOURCE_CATALOG.length);
    expect(RESOURCE_CATALOG.filter((item) => item.kind === 'apikey').every((item) => item.keyEnvName && item.validateEndpoint?.startsWith('https://'))).toBe(true);
  });

  it('renders a key entry form only for apikey resources', () => {
    vi.stubGlobal('fetch', stubFetch([]));
    render(<ConnectView />);
    const apiKeys = screen.getByRole('region', { name: 'API keys' });
    const forms = within(apiKeys).getAllByRole('form');
    expect(forms).toHaveLength(apiKeyCatalogResources().length);
    for (const resource of apiKeyCatalogResources()) {
      expect(within(apiKeys).getByLabelText(`${resource.displayName} API key`)).toHaveAttribute('type', 'password');
    }
    expect(within(screen.getByRole('region', { name: 'Subscriptions' })).queryByRole('form')).not.toBeInTheDocument();
  });

  it('stores a key through the loopback API and shows only the masked form + verdict', async () => {
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', stubFetch(posted));
    setMutationToken(TOKEN);
    const user = userEvent.setup();
    render(<ConnectView />);

    const apiKeys = screen.getByRole('region', { name: 'API keys' });
    const form = within(apiKeys).getByRole('form', { name: 'Store OpenAI API key' });
    const input = within(form).getByLabelText('OpenAI API key');
    await user.type(input, KEY_VALUE);
    await user.click(within(form).getByRole('button', { name: 'Store' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ resource: 'openai', value: KEY_VALUE });
    // The only echo is the masked last-4 + the validated verdict.
    expect(await within(apiKeys).findByText(`****${KEY_LAST4}`)).toBeInTheDocument();
    expect(within(apiKeys).getByText('validated')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(KEY_VALUE);
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('asks for the mutation token before posting when no hold exists', async () => {
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', stubFetch(posted));
    const user = userEvent.setup();
    render(<ConnectView />);

    const apiKeys = screen.getByRole('region', { name: 'API keys' });
    const form = within(apiKeys).getByRole('form', { name: 'Store OpenAI API key' });
    await user.type(within(form).getByLabelText('OpenAI API key'), KEY_VALUE);
    await user.click(within(form).getByRole('button', { name: 'Store' }));

    // No POST yet -- the token dialog gates the write.
    expect(posted).toHaveLength(0);
    const dialog = await screen.findByRole('dialog');
    const tokenInput = within(dialog).getByPlaceholderText('64 hex characters');
    await user.type(tokenInput, TOKEN);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));

    // Once unlocked, the pending key entry completes.
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ resource: 'openai', value: KEY_VALUE });
    expect(document.body.innerHTML).not.toContain(KEY_VALUE);
  });

  it('never renders key entry under the remote gateway marker', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="ashlr-remote-gateway" content="v1">');
    const fetchSpy = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    render(<ConnectView />);
    const apiKeys = screen.getByRole('region', { name: 'API keys' });
    expect(within(apiKeys).queryByRole('form')).not.toBeInTheDocument();
    expect(within(apiKeys).queryAllByLabelText(/API key$/)).toHaveLength(0);
    expect(within(apiKeys).getAllByText(/local console on this computer/).length).toBeGreaterThan(0);
    // The custody status read is withheld too -- nothing is requested remotely.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
