import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { APP_ACTIONS_API } from '../fleet-host/app-actions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { APP_CONTROL_API, MAC_APPS_API } from './composer-app-commands.js';
import { appActions, appDone, macApps } from './composer-apps.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const inboxPath = '/api/verse/leader/inbox';

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

async function setup(options: { routes?: Record<string, unknown>; post?: (url: string) => Response | undefined } = {}) {
  const net = stubSurfaceFetch({
    routes: {
      '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
      '/api/verse/leader/directives': { directives: [] },
      [MAC_APPS_API]: macApps(),
      [APP_ACTIONS_API]: appActions({ actions: [], total: 0, counts: {} }),
      ...options.routes,
    },
    post: url => options.post?.(url),
  });
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  const input = screen.getByRole('textbox', { name: 'Reply to the Leader' });
  const run = (text: string) => { fireEvent.change(input, { target: { value: text } }); fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' }); };
  return { net, input, run, log: screen.getByRole('log', { name: 'Conversation with the Leader' }) };
}

const posts = (net: Awaited<ReturnType<typeof setup>>['net'], url: string) => net.posted.filter(post => post.url === url);

describe('app commands in the Leader reply box', () => {
  it('/apps answers in the conversation without a token and writes nothing', async () => {
    const { net, input, run, log } = await setup();
    run('/apps');
    expect(await within(log).findByText(/^Apps on this Mac: Claude in front, 1\.5 GB · Phantom running, 300 MB · Safari running, 800 MB · Cursor not running\. Not installed: Codex\. Phantom has not acted on an app in the last 7 days\. \/app <name> opens one/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(net.posted).toEqual([]);
    expect(input).toHaveValue('');
  });

  it('/apps says the state is unknown when the server does not serve it', async () => {
    const { run, log } = await setup({ routes: { [MAC_APPS_API]: null } });
    run('/apps');
    expect(await within(log).findByText('App state is unknown: this server does not serve it yet. Phantom has not acted on an app in the last 7 days.')).toBeInTheDocument();
  });

  it('/app <name> opens the app through the control route and notes it to the leaders', async () => {
    setMutationToken('a'.repeat(64));
    const { net, input, run, log } = await setup({ post: url => (url === APP_CONTROL_API ? Response.json(appDone()) : undefined) });
    run('/app cur');
    expect(await within(log).findByText('Cursor: asked macOS to open Cursor.')).toBeInTheDocument();
    expect(posts(net, APP_CONTROL_API)).toEqual([{ url: APP_CONTROL_API, body: { app: 'cursor', action: 'open' } }]);
    await waitFor(() => expect(posts(net, inboxPath)).toEqual([{ url: inboxPath, body: { source: 'Phantom desktop', text: '[composer] /app cur: done' } }]));
    expect(input).toHaveValue('');
  });

  it('/app shows the refusal the server gave and leaves no note', async () => {
    setMutationToken('a'.repeat(64));
    const refused = appDone({ ok: false, outcome: 'refused', code: 'not-allowlisted', detail: 'not in apps-allow.json.' });
    const { net, run, log } = await setup({ post: url => (url === APP_CONTROL_API ? Response.json(refused, { status: 422 }) : undefined) });
    run('/app cursor');
    expect(await within(log).findByText('/app cursor failed: Phantom refused: not in apps-allow.json.')).toBeInTheDocument();
    expect(posts(net, inboxPath)).toEqual([]);
  });

  it('/app on a name no app has asks nothing of the server', async () => {
    setMutationToken('a'.repeat(64));
    const { net, run, log } = await setup();
    run('/app xcode');
    expect(await within(log).findByText('/app xcode failed: No app Phantom knows is named "xcode". It can open Cursor, Safari.')).toBeInTheDocument();
    expect(net.posted).toEqual([]);
  });

  it('/app without a token asks to unlock first and posts nothing', async () => {
    const { net, run } = await setup();
    run('/app cursor');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(net.posted).toEqual([]);
  });
});
