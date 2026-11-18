import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { validateBusEnvelope } from '../../../../core/fleet/bus-envelope.js';
import { DirectBox } from './DirectBox.js';

/** A fake agent bus: validates with the real envelope contract, dedupes by id, assigns cursors. */
function fakeBus(opts: { failWith?: number } = {}) {
  const retained = new Map<string, { cursor: number; envelope: unknown }>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toContain('/api/verse/agent-bus');
    if (opts.failWith) return new Response('{}', { status: opts.failWith });
    const envelope = JSON.parse(String(init?.body));
    const checked = validateBusEnvelope(envelope);
    if (!checked.ok) return new Response('{}', { status: 400 });
    const id = (envelope as { id: string }).id;
    const hit = retained.get(id);
    if (hit) return Response.json({ status: 'duplicate', cursor: hit.cursor });
    retained.set(id, { cursor: retained.size + 1, envelope });
    return Response.json({ status: 'posted', cursor: retained.size });
  });
  return { retained, fetchMock };
}

beforeEach(() => setMutationToken('a'.repeat(64)));
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

const type = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Direct to leaders' }), { target: { value } });

it('round-trips one line to the leaders as a P0 interjection and clears the line', async () => {
  const bus = fakeBus(); vi.stubGlobal('fetch', bus.fetchMock);
  render(<DirectBox />);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  type('  ship the release now  ');
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  await screen.findByText('Posted · cursor 1.');
  const [{ cursor, envelope }] = [...bus.retained.values()];
  expect(cursor).toBe(1);
  expect(envelope).toMatchObject({ from: 'mason', to: 'leaders', priority: 'P0', body: { kind: 'interjection', channel: 'desktop', text: 'ship the release now' } });
  expect(screen.getByRole('textbox')).toHaveValue('');
});

it('treats a resend of the same line as already on the bus', async () => {
  const bus = fakeBus(); vi.stubGlobal('fetch', bus.fetchMock);
  render(<DirectBox />);
  for (const expected of ['Posted · cursor 1.', 'Already on the bus.']) {
    type('same line'); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(expected);
  }
  expect(bus.retained.size).toBe(1);
});

it.each([[404, /without --allow-dispatch/], [507, /bus is full/i]])('keeps the line when the bus answers %s', async (status, message) => {
  vi.stubGlobal('fetch', fakeBus({ failWith: status }).fetchMock);
  render(<DirectBox />);
  type('hello'); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('status')).toHaveTextContent(message);
  expect(screen.getByRole('textbox')).toHaveValue('hello');
});

it('does not touch the bus while mutations are locked', async () => {
  clearMutationToken();
  const bus = fakeBus(); vi.stubGlobal('fetch', bus.fetchMock);
  render(<DirectBox />);
  type('hello'); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/Unlock mutations/);
  expect(bus.fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('hello');
});
