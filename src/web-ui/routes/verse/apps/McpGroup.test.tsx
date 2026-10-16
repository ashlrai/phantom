import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpSnapshot } from '../mcp/mcp-contract.js';
import { McpGroup, type GatedRun } from './McpGroup.js';

import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { afterEach } from 'vitest';
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

describe('MCP identity setup guidance', () => {
  it('explains missing Phantom and authority custody without restoring any identity', () => {
    const run = vi.fn();
    const snapshot: McpSnapshot = {
      sampledAt: null, seats: [], machine: { servers: [], configured: false, note: '' }, notes: [],
      scope: { available: true, pinned: true, aliasRef: 'client', tenantRef: 'tenant', principalRef: null,
        reason: 'mcp-scope-expired', setupIssues: ['phantom_unavailable', 'authority_anchor_unavailable', 'SECRET-CANARY'] },
    };
    render(<McpGroup snapshot={snapshot} cliHealth={null} unavailable={null} loading={false} run={run} onAdded={() => {}} />);
    expect(screen.getByText(/The Locus pin has expired/)).toHaveTextContent('a human must select and restore the intended pin');
    expect(screen.getByText(/Phantom is not available to Locus/)).toHaveTextContent('PATH');
    expect(screen.getByText(/The Locus authority anchor is unavailable/)).toHaveTextContent('locus doctor');
    expect(screen.queryByText('SECRET-CANARY')).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });
});


const proposal = { server: { name: 'synthetic', command: 'node', args: [], env: { TOKEN: '<set>' }, sourceRef: '~/.mcp.json' },
  target: { ref: '~/.mcp.json', label: 'Hub' }, digest: 'synthetic-digest', action: 'add', replaces: null, warnings: [], note: '' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup(run: GatedRun = async (_reason, action) => action()) {
  setMutationToken(TEST_TOKEN);
  const onAdded = vi.fn();
  const view = render(<McpGroup snapshot={null} cliHealth={null} unavailable={null} loading={false} run={run} onAdded={onAdded} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'synthetic' } });
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } });
  fireEvent.change(screen.getByLabelText(/Environment/), { target: { value: 'TOKEN=synthetic-secret' } });
  return { onAdded, ...view };
}

it.each(['Cancel', 'Close'])('clears every sensitive draft when dismissed through %s', async button => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
  expect(screen.getByLabelText('Name')).toHaveValue('');
  expect(screen.getByLabelText('Command')).toHaveValue('');
  expect(screen.getByLabelText(/Environment/)).toHaveValue('');
});

it('ignores a late Review response after dismissal and reopening', async () => {
  const pending = deferred<Response>();
  installFetch(() => pending.promise);
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
  await act(async () => { pending.resolve(json(proposal)); });
  expect(screen.getByRole('dialog')).toHaveTextContent('Add an MCP server');
  expect(screen.queryByText('Review before adding')).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Environment/)).toHaveValue('');
});

it('reports an already issued Apply even after dismissal without closing a newer form', async () => {
  const pending = deferred<Response>();
  const { calls } = installFetch(call => call.path.endsWith('/proposal') ? json(proposal) : pending.promise);
  const { onAdded } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByRole('dialog', { name: 'Review before adding' });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add server' }));
  await waitFor(() => expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onAdded).toHaveBeenCalledWith(expect.stringContaining('does not cancel'));
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
  await act(async () => { pending.resolve(json({ ok: true })); });
  expect(onAdded).toHaveBeenCalledWith(expect.stringContaining('Added synthetic'));
  expect(screen.getByRole('dialog', { name: 'Add an MCP server' })).toBeInTheDocument();
  expect(screen.getByLabelText(/Environment/)).toHaveValue('');
});


it.each(['Escape', 'Backdrop'])('clears drafts through %s dismissal', async method => {
  setup();
  const dialog = screen.getByRole('dialog');
  if (method === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' });
  else fireEvent.mouseDown(dialog.parentElement!);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
  expect(screen.getByLabelText(/Environment/)).toHaveValue('');
});

it('revokes a Review parked behind the token gate when the form is dismissed', async () => {
  let parked!: () => Promise<unknown>;
  const pending = deferred<unknown>();
  const run: GatedRun = <T,>(_reason: string, action: () => Promise<T>) => {
    parked = action;
    return pending.promise as Promise<T | null>;
  };
  const { calls } = installFetch(() => json(proposal));
  setup(run);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await act(async () => { pending.resolve(await parked()); });
  expect(calls).toHaveLength(0);
});

it('revokes a parked Apply before issuance and does not report a canceled write', async () => {
  let parked!: () => Promise<unknown>;
  const pending = deferred<unknown>();
  let gated = 0;
  const run: GatedRun = async <T,>(_reason: string, action: () => Promise<T>) => {
    if (++gated === 1) return action();
    parked = action;
    return pending.promise as Promise<T | null>;
  };
  const { calls } = installFetch(() => json(proposal));
  const { onAdded } = setup(run);
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByRole('dialog', { name: 'Review before adding' });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add server' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await act(async () => { pending.resolve(await parked()); });
  expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
  expect(onAdded).not.toHaveBeenCalled();
});


it('does not call an unmounted page with a hidden completion notice', async () => {
  const pending = deferred<Response>();
  const { calls } = installFetch(call => call.path.endsWith('/proposal') ? json(proposal) : pending.promise);
  const { onAdded, unmount } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByRole('dialog', { name: 'Review before adding' });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add server' }));
  await waitFor(() => expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1));
  unmount();
  await act(async () => { pending.resolve(json({ ok: true })); });
  expect(onAdded).not.toHaveBeenCalled();
  expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
});


it('does not mistake a malformed successful Apply body for confirmation or gate cancellation', async () => {
  installFetch(call => call.path.endsWith('/proposal') ? json(proposal) : json(null));
  const { onAdded } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByRole('dialog', { name: 'Review before adding' });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add server' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Refresh the configuration before trying again');
  expect(onAdded).not.toHaveBeenCalledWith(expect.stringContaining('Added synthetic'));
});
