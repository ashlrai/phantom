// RQ-PHX-STEERSCREENSHOT90: the steer box accepts one pasted or dropped
// screenshot (PNG/JPEG, ≤5 MB) and sends it as the wire `image` field.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';

const token = 'a'.repeat(64);
// Tiny generated fixture — PNG magic plus padding, never a real screenshot.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0x42)]);

function stub(status = 201, body: unknown = { at: '2026-11-10T12:00:00Z' }, inbox: unknown[] = []) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST' ? Response.json(body, { status }) : Response.json({ inbox }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => { sessionStorage.clear(); evictAll(); setMutationToken(token); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

function paste(box: HTMLElement, file: File) {
  fireEvent.paste(box, { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } });
}

it('shows a removable chip after pasting a PNG', async () => {
  stub();
  render(<InterjectBox />);
  await screen.findByText('Nothing in the inbox yet.');
  paste(screen.getByRole('textbox'), new File([PNG_BYTES], 'shot.png', { type: 'image/png' }));
  const chip = await screen.findByRole('button', { name: /screenshot attached \(1 KB\)/ });
  fireEvent.click(chip);
  expect(screen.queryByRole('button', { name: /screenshot attached/ })).not.toBeInTheDocument();
});

it('accepts a dropped JPEG', async () => {
  stub();
  render(<InterjectBox />);
  await screen.findByText('Nothing in the inbox yet.');
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'shot.jpg', { type: 'image/jpeg' });
  fireEvent.drop(screen.getByRole('textbox').closest('form')!, { dataTransfer: { files: [file], types: ['Files'] } });
  expect(await screen.findByRole('button', { name: /screenshot attached \(1 KB\)/ })).toBeInTheDocument();
});

it.each([
  ['an over-5 MB image', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }), 'Screenshots are limited to 5 MB.'],
  ['a non-PNG/JPEG file', new File([new Uint8Array(8)], 'shot.gif', { type: 'image/gif' }), 'Only PNG or JPEG screenshots can be attached.'],
])('rejects %s with a plain message and no chip', async (_name, file, message) => {
  stub();
  render(<InterjectBox />);
  await screen.findByText('Nothing in the inbox yet.');
  paste(screen.getByRole('textbox'), file);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /screenshot attached/ })).not.toBeInTheDocument();
});

it('sends the image base64 with the post and clears the chip', async () => {
  const fetcher = stub();
  render(<InterjectBox />);
  await screen.findByText('Nothing in the inbox yet.');
  const box = screen.getByRole('textbox');
  paste(box, new File([PNG_BYTES], 'shot.png', { type: 'image/png' }));
  await screen.findByRole('button', { name: /screenshot attached/ });
  fireEvent.change(box, { target: { value: 'Fleet page looks wrong here' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/^Sent ·/);
  expect(screen.queryByRole('button', { name: /screenshot attached/ })).not.toBeInTheDocument();
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  const body = JSON.parse(String(posts[0]![1]!.body));
  expect(body.text).toBe('Fleet page looks wrong here');
  expect(body.requestId).toMatch(/^req-/);
  expect(body.image).toBe(btoa(String.fromCharCode(...PNG_BYTES)));
});
