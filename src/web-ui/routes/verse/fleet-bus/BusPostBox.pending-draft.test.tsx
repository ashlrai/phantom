import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BusPostBox, type BusPostPrefill } from './BusPostBox.js';
import { postBusEnvelope } from './agent-bus-post.js';
import type { PostOutcome } from './bus-post-model.js';

vi.mock('./agent-bus-post.js', () => ({ postBusEnvelope: vi.fn() }));
const post = vi.mocked(postBusEnvelope);
const onPosted = vi.fn();
const replyA = { to: 'agent', replyTo: 'message-a', quote: 'First message' };
const replyB = { to: 'agent', replyTo: 'message-b', quote: 'Second message' };

function Harness() {
  const [prefill, setPrefill] = useState<BusPostPrefill | null>(null);
  return <>
    <button onClick={() => setPrefill({ ...replyA })}>Reply A</button>
    <button onClick={() => setPrefill({ ...replyB })}>Reply B</button>
    <BusPostBox senders={['agent']} prefill={prefill} onPosted={onPosted} />
  </>;
}

function deferred() {
  let resolve!: (value: PostOutcome) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<PostOutcome>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function compose() {
  fireEvent.click(screen.getByRole('button', { name: 'Reply A' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'On it' } });
}
function send() { fireEvent.click(screen.getByRole('button', { name: 'Send' })); }

beforeEach(() => { post.mockReset(); onPosted.mockReset(); });
afterEach(cleanup);

it('keeps the next reply selected while the previous send succeeds', async () => {
  const first = deferred();
  post.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ status: 'posted', cursor: 2 });
  render(<Harness />); compose(); send();
  fireEvent.click(screen.getByRole('button', { name: 'Reply B' }));
  expect(screen.getByText('Replying to: Second message')).toBeVisible();
  await act(async () => first.resolve({ status: 'posted', cursor: 1 }));
  expect(onPosted).toHaveBeenCalledWith(1);
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('On it');
  expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('agent');
  expect(screen.getByText('Replying to: Second message')).toBeVisible();
  send();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0]![0]).toMatchObject({ to: 'agent', body: { text: 'On it', replyTo: 'message-a' } });
  expect(post.mock.calls[1]![0]).toMatchObject({ to: 'agent', body: { text: 'On it', replyTo: 'message-b' } });
  expect(post.mock.calls[1]![0].id).not.toBe(post.mock.calls[0]![0].id);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''));
});

it('clears the submitted reply after an ordinary success', async () => {
  const pending = deferred(); post.mockReturnValueOnce(pending.promise);
  render(<Harness />); compose(); send();
  await act(async () => pending.resolve({ status: 'posted', cursor: 3 }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  expect(screen.queryByText('Replying to: First message')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Posted');
  expect(onPosted).toHaveBeenCalledWith(3);
});

it.each(['failure result', 'rejected promise'])('preserves and retries the same envelope after a %s', async failure => {
  const pending = deferred();
  post.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ status: 'duplicate', cursor: 4 });
  render(<Harness />); compose(); send();
  await act(async () => {
    if (failure === 'failure result') pending.resolve({ status: 'unavailable' });
    else pending.reject(new Error('transport failed'));
  });
  expect(screen.getByRole('status')).toHaveTextContent('The bus is unavailable.');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('On it');
  expect(screen.getByText('Replying to: First message')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  send();
  await screen.findByText('Already on the bus.');
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1]![0]).toEqual(post.mock.calls[0]![0]);
});

it('sends only once when clicked rapidly', async () => {
  const pending = deferred(); post.mockReturnValueOnce(pending.promise);
  render(<Harness />); compose(); send(); send();
  expect(post).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  await act(async () => pending.resolve({ status: 'posted', cursor: 5 }));
});
