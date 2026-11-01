import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

const props = { visible: true } as PaneProps;

const MINUTE = 60 * 1000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const accountsBody = (observedAt: string) => ({
  sampledAt: '2026-10-31T12:00:00Z',
  refreshing: false,
  accounts: [
    {
      id: 'claude-1', label: 'Claude Max', provider: 'claude', state: 'observed', authentication: 'signed-in',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 58, resetsAt: null, resetDescription: 'resets Thu at midnight', limitReached: false, measured: true }],
    },
    {
      id: 'codex-1', label: 'Codex Personal', provider: 'codex', state: 'observed', authentication: 'signed-in',
      observedAt,
      planType: 'pro',
      reconnectCommand: 'ashlr auth login codex',
      credits: { hasCredits: true, unlimited: false, balance: '42', spendControlReached: false },
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: null, limitReached: false, measured: true }],
    },
    {
      id: 'grok-1', label: 'Grok', provider: 'grok', state: 'signed-out', authentication: 'signed-out',
      reason: 'reconnect through `ashlr resources`', reconnectCommand: 'ashlr auth login grok', windows: [],
    },
  ],
});

const plainBody = () => ({
  sampledAt: '2026-10-31T12:00:00Z',
  refreshing: false,
  accounts: [accountsBody('unused').accounts[0]],
});

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}
const stubReads = (accounts: unknown) => stubFetch((url) =>
  url.includes('/api/verse/accounts') ? Response.json(accounts) : Response.json({}, { status: 404 }));

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the reading age, the spendable-credits fact, the plan and a working copy button', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const observed = inMs(-10 * MINUTE);
  stubReads(accountsBody(observed));
  render(<FleetUsagePane {...props} />);

  const label = await screen.findByText('Codex Personal · pro');
  const codexRow = label.closest('li') as HTMLElement;
  const time = codexRow.querySelector('time') as HTMLTimeElement | null;
  expect(time).not.toBeNull();
  expect(time?.getAttribute('dateTime')).toBe(observed);
  expect(time).toHaveTextContent('as of 10m ago');
  expect(codexRow).toHaveTextContent('credits: 42 — credits keep this account usable past the weekly limit');

  fireEvent.click(within(codexRow).getByRole('button', { name: 'Copy reconnect command' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('ashlr auth login codex'));
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(await within(codexRow).findByText('Copied')).toBeInTheDocument();

  // The reconnect action also reaches a signed-out row beneath its reason.
  const grokRow = (await screen.findByText('Grok')).closest('li') as HTMLElement;
  fireEvent.click(within(grokRow).getByRole('button', { name: 'Copy reconnect command' }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('ashlr auth login grok'));
  expect(await within(grokRow).findByRole('status')).toHaveTextContent('Copied');
});

it.each([
  [true, '42', 'the provider reports credit spending held'],
  [undefined, '42', 'credit spending control is unconfirmed'],
  [false, '0', 'no spendable credit balance is reported'],
])('describes credit spending honestly with hold %s and balance %s', async (hold, balance, message) => {
  const body = accountsBody(inMs(-10 * MINUTE));
  stubReads({
    ...body,
    accounts: body.accounts.map((account) => account.id === 'codex-1'
      ? { ...account, credits: { hasCredits: true, unlimited: false, balance, spendControlReached: hold } }
      : account),
  });
  render(<FleetUsagePane {...props} />);
  const row = (await screen.findByText('Codex Personal · pro')).closest('li') as HTMLElement;
  expect(row).toHaveTextContent(`credits: ${balance} — ${message}`);
  expect(row).not.toHaveTextContent('credits keep this account usable past the weekly limit');
});

it('renders exactly the plain row when the account carries none of the four facts', async () => {
  stubReads(plainBody());
  render(<FleetUsagePane {...props} />);
  const label = await screen.findByText('Claude Max');
  const row = label.closest('li') as HTMLElement;
  expect(label.textContent).toBe('Claude Max');
  expect(row.querySelector('time')).toBeNull();
  expect(within(row).queryByRole('button')).toBeNull();
  expect(row).not.toHaveTextContent(/as of|credits keep|Copy/i);
  expect(within(row).getAllByRole('meter')).toHaveLength(1);
  expect(within(row).getByText('resets Thu at midnight')).toBeInTheDocument();
});

it('says Copy failed when the clipboard rejects the write', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'));
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  stubReads(accountsBody(inMs(-10 * MINUTE)));
  render(<FleetUsagePane {...props} />);
  const codexRow = (await screen.findByText('Codex Personal · pro')).closest('li') as HTMLElement;
  fireEvent.click(within(codexRow).getByRole('button', { name: 'Copy reconnect command' }));
  expect(await within(codexRow).findByText('Copy failed')).toBeInTheDocument();
});
