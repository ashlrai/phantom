import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { BusPostBox } from './BusPostBox.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiPost: vi.fn() }));
const post = vi.mocked(apiPost);
const onPosted = vi.fn();
beforeEach(() => { setMutationToken('a'.repeat(64)); post.mockReset(); onPosted.mockReset(); });
afterEach(() => { cleanup(); clearMutationToken(); });
function setup() { render(<BusPostBox senders={['agent']} prefill={null} onPosted={onPosted} />); }
function writeAndSend(text = 'hello') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

it('disables blank sends and posts with the held token', async () => {
  post.mockResolvedValue({ status: 'posted', cursor: 4 }); setup();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  writeAndSend('  ');
  expect(post).not.toHaveBeenCalled();
  writeAndSend();
  await screen.findByText(/Posted/);
  expect(post).toHaveBeenCalledWith('/api/verse/agent-bus', expect.objectContaining({ to: 'leaders', body: expect.objectContaining({ text: 'hello' }) }), 'a'.repeat(64));
  expect(onPosted).toHaveBeenCalledWith(4);
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

it.each([
  ['duplicate', { status: 'duplicate', cursor: 1 }, /already on the bus/i],
  ['404', new ApiError('fake', 404, '/api/verse/agent-bus'), /started without --allow-dispatch/],
  ['507', new ApiError('fake', 507, '/api/verse/agent-bus'), /bus is full/i],
])('shows %s without clearing the draft', async (_name, response, message) => {
  if (response instanceof Error) post.mockRejectedValue(response); else post.mockResolvedValue(response);
  setup(); writeAndSend();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(message));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('hello');
  expect(onPosted).not.toHaveBeenCalled();
});

it('retries the exact envelope after an uncertain failure', async () => {
  post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'duplicate', cursor: 1 });
  setup(); writeAndSend(); await screen.findByText(/unavailable/i);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/already on the bus/i);
  expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]);
});

it('reports a locked mutation without making a request', async () => {
  clearMutationToken(); setup(); writeAndSend();
  await screen.findByText(/unlock mutations/i);
  expect(post).not.toHaveBeenCalled();
});
