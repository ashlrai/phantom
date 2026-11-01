import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken, setRemoteActGranted } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { mobileAgentBusPageQuery } from './agent-bus-page-query.js';
import { resetGuard, isGuardOpen } from '../shell/guard-store.js';
import * as remoteSession from '../../../data/remote-session.js';
import { BusSection } from './BusSection.js';
import { json, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

afterEach(() => { document.head.innerHTML = ''; setRemoteActGranted(false); resetGuard(); clearMutationToken(); evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(status = 201) {
  setMutationToken(TOKEN);
  const read = vi.spyOn(mobileAgentBusPageQuery, 'fetch').mockResolvedValue({ v: 1, status: 'ok', nextCursor: 1,
    messages: [{ cursor: 1, receivedAt: Date.now(), envelope: { id: 'fake', from: 'worker-fake', to: 'leaders', priority: 'P0', ttl: 10000, body: 'hello' } }] });
  const fetch = stubFetch({ 'POST /api/verse/agent-bus': () => json(status === 201 ? { status: 'posted', cursor: 123 } : {}, status) });
  renderMobile(<BusSection />);
  return { read, ...fetch };
}
it('posts a trimmed phone envelope to the chosen target then refetches', async () => {
  const { read, posts } = setup();
  const target = await screen.findByRole('combobox', { name: 'To' });
  expect(target).toHaveValue('leaders');
  fireEvent.change(target, { target: { value: 'worker-fake' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '  fake phone post  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Posted · cursor 123.')).toBeInTheDocument();
  expect(posts()).toHaveLength(1);
  expect(posts()[0].body).toMatchObject({ from: 'mason', to: 'worker-fake', body: { channel: 'phone', text: 'fake phone post' } });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});
it('renders a refusal and retains the draft', async () => {
  const { read } = setup(507);
  const text = await screen.findByRole('textbox', { name: 'Message' });
  fireEvent.change(text, { target: { value: 'fake refused message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('The bus is full.')).toBeInTheDocument();
  expect(text).toHaveValue('fake refused message');
  expect(read).toHaveBeenCalledTimes(1);
});

it('uses the remote phone mutation transport', async () => {
  const { posts } = setup();
  document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
  setRemoteActGranted(true);
  const mutate = vi.spyOn(remoteSession, 'remoteMutate').mockResolvedValue({ status: 'posted', cursor: 124 });
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: 'fake remote post' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Posted · cursor 124.')).toBeInTheDocument();
  expect(mutate).toHaveBeenCalledWith('POST', '/api/verse/agent-bus', expect.objectContaining({ from: 'mason', body: expect.objectContaining({ channel: 'phone' }) }));
  expect(posts()).toHaveLength(0);
});
it('requires the mutation guard before posting without a hold', async () => {
  const { posts } = setup();
  clearMutationToken();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: 'fake guarded post' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(isGuardOpen()).toBe(true);
  expect(posts()).toHaveLength(0);
});
