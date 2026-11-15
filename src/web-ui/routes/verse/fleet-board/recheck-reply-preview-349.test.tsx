/** RQ-PHX-RECHECKREPLYPREVIEW349 — model states and the preview component. Fake text only. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { deriveReplyPreview } from './recheck-reply-model.js';
import { RecheckReplyPreview } from './RecheckReplyPreview.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('derives loading, absent, unreadable and ready', () => {
  expect(deriveReplyPreview(undefined).state).toBe('loading');
  expect(deriveReplyPreview(null).state).toBe('absent');
  expect(deriveReplyPreview('error').text).toBe('Thread reply is not on this Phantom build');
  for (const reply of [42, '', 'x'.repeat(901)]) expect(deriveReplyPreview({ reply }).state).toBe('unreadable');
  expect(deriveReplyPreview({ reply: 'x'.repeat(900) }).state).toBe('ready');
  expect(deriveReplyPreview({ reply: 'a\nb' })).toEqual({ state: 'ready', text: 'a\nb' });
});

it('shows the text verbatim and copies exactly it', async () => {
  const text = 'Runtime: fake-host <b>1.2.3</b>\nVerdict: BLOCKED';
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('fetch', vi.fn(async () => json({ reply: text })));
  const { container } = render(<RecheckReplyPreview />);
  await waitFor(() => expect(container.querySelector('pre')!.textContent).toBe(text));
  expect(container.querySelector('pre b')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
  expect(writeText).toHaveBeenCalledWith(text);
});

it('reports a failed copy', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('no'); }) } });
  vi.stubGlobal('fetch', vi.fn(async () => json({ reply: 'hello' })));
  render(<RecheckReplyPreview />);
  const btn = screen.getByRole('button', { name: 'Copy' });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByText('Copy failed')).toBeInTheDocument());
});

it('disables Copy when the route is absent', async () => {
  const fetchMock = vi.fn(async () => json({}, 404));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<RecheckReplyPreview />);
  await waitFor(() => expect(container.querySelector('pre')!.textContent).toBe('Thread reply is not on this Phantom build'));
  expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
});
