import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { InterjectDialog } from './InterjectDialog.js';
import { closeInterjectDialog, openInterjectDialog } from './interject-dialog-store.js';

const token = 'a'.repeat(64);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { setMutationToken(token); });
afterEach(() => { act(closeInterjectDialog); clearMutationToken(); vi.unstubAllGlobals(); });

async function setup() {
  const user = userEvent.setup();
  render(<InterjectDialog />);
  act(openInterjectDialog);
  const textarea = await screen.findByRole('textbox', { name: 'Message' });
  return { user, textarea };
}

describe('fleet interjection dialog', () => {
  it('focuses the message, posts trimmed text, and closes after confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, at: '2026-10-31T00:52:00Z' }));
    vi.stubGlobal('fetch', fetchMock);
    const { user, textarea } = await setup();
    await waitFor(() => expect(textarea).toHaveFocus());
    await user.type(textarea, '  Please check the queue  ');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    const date = new Date('2026-10-31T00:52:00Z');
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    expect(await screen.findByText(`Landed at ${time} — the leaders read newest first`)).toBeInTheDocument();
    const [path, options] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/verse/fleet/runs/inbox');
    expect(JSON.parse(options.body)).toEqual({ text: 'Please check the queue', source: 'Phantom desktop' });
    expect(options.headers['x-ashlr-token']).toBe(token);
    expect(textarea).toHaveValue('');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 3000 });
  }, 15000);

  it('shows a 400 reason and keeps the text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Message is too long.' }, 400)));
    const { user, textarea } = await setup();
    await user.type(textarea, 'Keep this text');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Message is too long.');
    expect(textarea).toHaveValue('Keep this text');
  });

  it('explains a missing route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'not found' }, 404)));
    const { user, textarea } = await setup();
    await user.type(textarea, 'Hello');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This build has no fleet inbox route yet.');
    expect(textarea).toHaveValue('Hello');
  });

  it('disables sending while the request is pending', async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('fetch', fetchMock);
    const { user, textarea } = await setup();
    await user.type(textarea, 'Hello');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(json({ error: 'Try again.' }, 400)); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again.');
  });

  it('refuses empty text and explains the locked state', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    clearMutationToken();
    const { user, textarea } = await setup();
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a message first.');
    await user.type(textarea, 'Hello');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unlock actions with the mutation token first.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
