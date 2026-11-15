import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const mutations = vi.hoisted(() => ({ pauseFleet: vi.fn(async () => {}), resumeFleet: vi.fn(async () => {}) }));
vi.mock('../../../data/mutations.js', async importOriginal => ({ ...await importOriginal<object>(), ...mutations }));

const inboxPath = '/api/verse/leader/inbox';

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); mutations.pauseFleet.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

function serve() {
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
  } });
}

async function setup() {
  const net = serve();
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  return { net, input: screen.getByRole('textbox', { name: 'Reply to the Leader' }) };
}

const inboxPosts = (net: ReturnType<typeof serve>) => net.posted.filter(post => post.url === inboxPath);

describe('Leader composer slash commands', () => {
  it('/pause + Enter opens the confirm; cancel sends nothing', async () => {
    const { net, input } = await setup();
    fireEvent.change(input, { target: { value: '/pause' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: 'Pause the fleet?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pause the fleet?' })).toBeNull());
    expect(mutations.pauseFleet).not.toHaveBeenCalled();
    expect(inboxPosts(net)).toEqual([]);
    expect(input).toHaveValue('/pause');
  });

  it('confirming calls pauseFleet once, shows the system line and notes it to the leaders', async () => {
    const { net, input } = await setup();
    fireEvent.change(input, { target: { value: '/pause' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Pause the fleet?' })).getByRole('button', { name: 'Yes, pause' }));
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('Paused the fleet')).toBeInTheDocument();
    expect(mutations.pauseFleet).toHaveBeenCalledTimes(1);
    expect(inboxPosts(net)).toEqual([{ url: inboxPath, body: { source: 'Phantom desktop', text: '[composer] /pause: done' } }]);
    expect(input).toHaveValue('');
  });

  it('a plain line still sends a normal message', async () => {
    const { net, input } = await setup();
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(inboxPosts(net)).toEqual([{ url: inboxPath, body: { source: 'Phantom desktop', text: 'hi' } }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an unknown /word is sent unchanged and plain Enter does not send a message', async () => {
    const { net, input } = await setup();
    fireEvent.change(input, { target: { value: '/unknown thing' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(inboxPosts(net)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(inboxPosts(net)).toEqual([{ url: inboxPath, body: { source: 'Phantom desktop', text: '/unknown thing' } }]));
  });

  it('shows hints while the draft starts with "/", Tab completes, /help answers locally', async () => {
    const { net, input } = await setup();
    expect(screen.queryByRole('list', { name: 'Composer commands' })).toBeNull();
    fireEvent.change(input, { target: { value: '/re' } });
    const hints = screen.getByRole('list', { name: 'Composer commands' });
    expect(within(hints).getAllByRole('listitem').map(item => item.textContent)).toEqual(['/resume Resume the fleet', '/release <lane> Release a lane hold']);
    fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });
    expect(input).toHaveValue('/resume');
    fireEvent.change(input, { target: { value: '/help' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(await screen.findByText(/^Commands: \/pause/)).toBeInTheDocument();
    expect(net.posted).toEqual([]);
  });

  it('/release with no lane shows an error line and calls nothing', async () => {
    const { net, input } = await setup();
    fireEvent.change(input, { target: { value: '/release' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(await screen.findByText('/release needs a lane: /release <lane>')).toBeInTheDocument();
    expect(net.posted).toEqual([]);
  });
});
