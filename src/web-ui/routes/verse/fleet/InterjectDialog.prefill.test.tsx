import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { InterjectDialog } from './InterjectDialog.js';
import { closeInterjectDialog, openInterjectDialog } from './interject-dialog-store.js';

afterEach(() => { evictAll(); act(closeInterjectDialog); clearMutationToken(); vi.unstubAllGlobals(); });

it('seeds the message once and places the caret at the end, including in StrictMode', async () => {
  render(<StrictMode><InterjectDialog /></StrictMode>);
  const prefill = 'Re RQ-PHX-FOO (codex-personal): ';
  act(() => openInterjectDialog({ prefill }));
  const textarea = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea).toHaveValue(prefill));
  expect(textarea.selectionStart).toBe(prefill.length);
  expect(textarea.selectionEnd).toBe(prefill.length);
  act(closeInterjectDialog);
  act(openInterjectDialog);
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

it('opens empty without a prefill', () => {
  render(<InterjectDialog />);
  act(openInterjectDialog);
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

it('sends a steering note with its job context to the inbox', async () => {
  setMutationToken('a'.repeat(64));
  const fetcher = vi.fn(async (_path: string, options: RequestInit) => Response.json(options.method === 'GET' ? { inbox: [] } : { ok: true, at: '2026-10-31T00:52:00Z' }));
  vi.stubGlobal('fetch', fetcher);
  const user = userEvent.setup();
  render(<InterjectDialog />);
  act(() => openInterjectDialog({ prefill: 'Re RQ-PHX-FOO (codex-personal): ' }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'stop touching dock-store');
  await user.click(screen.getByRole('button', { name: /Send/ }));
  await screen.findByRole('status');
  const post = fetcher.mock.calls.find(([, options]) => options.method === 'POST')!;
  expect(post[0]).toBe('/api/verse/fleet/runs/inbox');
  expect(JSON.parse(post[1].body as string)).toEqual({ text: 'Re RQ-PHX-FOO (codex-personal): stop touching dock-store', source: 'Phantom desktop', requestId: expect.stringMatching(/^req-[A-Za-z0-9._:-]{4,124}$/) });
});
