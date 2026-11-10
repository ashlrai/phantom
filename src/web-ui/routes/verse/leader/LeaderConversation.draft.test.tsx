/**
 * Leader drafts persist: a half-written message (main box or a question's
 * answer box) survives unmount/remount, is cleared once a send is accepted,
 * survives a cancelled token dialog, and is wiped with the logout wipe.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { useQuery } from '../../../data/hooks.js';
import { clearComposerMemory } from '../chat/composer-memory.js';
import { loadMarkdownRenderer } from '../MessageMarkdown.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { leaderState } from '../command/fixtures.test-support.js';
import { leaderQuery } from '../command/surface-data.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { LeaderConversation } from './LeaderConversation.js';
import { resetLeaderFocus } from './leader-focus.js';
import { directives, msg, threadMessages } from './thread-fixtures.test-support.js';

const TOKEN = 'a'.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch() {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        posts.push(body);
        return json({ message: msg({ id: `s${posts.length}`, from: 'mason', text: String(body['text']) }), reply: null });
      }
      const path = url.split('?')[0];
      if (path === '/api/verse/leader/thread') return json({ messages: threadMessages() });
      if (path === '/api/verse/leader/directives') return json({ directives: directives() });
      if (path === '/api/verse/leader') return json(leaderState('live'));
      return json({ error: 'not found' }, 404);
    }),
  );
  return posts;
}

function Harness() {
  const leader = useQuery(leaderQuery);
  const actions = useSurfaceActions();
  return (
    <>
      <ActionStatus actions={actions} />
      <LeaderConversation leader={leader.data} actions={actions} dormant={false} />
      {actions.dialogs}
    </>
  );
}

async function mount() {
  const view = render(<Harness />);
  await screen.findByRole('log', { name: 'Conversation with the Leader' });
  return view;
}

const composer = () => screen.getByRole('textbox', { name: 'Message the Leader' });
const answerBox = async () => within(await screen.findByRole('article', { name: 'Leader question' })).getByRole('textbox', { name: /^Answer the Leader:/ });

beforeAll(async () => {
  await loadMarkdownRenderer();
});

beforeEach(() => {
  localStorage.clear();
  clearComposerMemory();
  evictAll();
  clearMutationToken();
  resetLeaderFocus();
  resetVerseUi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  clearComposerMemory();
  localStorage.clear();
});

describe('LeaderConversation — draft persistence', () => {
  it('brings a half-written message back after unmount and remount', async () => {
    stubFetch();
    const first = await mount();
    await userEvent.type(composer(), 'Half a thought about lanes');
    first.unmount();
    await mount();
    expect(composer()).toHaveValue('Half a thought about lanes');
  });

  it('clears the stored draft when a send is accepted', async () => {
    setMutationToken(TOKEN);
    const posts = stubFetch();
    const first = await mount();
    await userEvent.type(composer(), 'Pause binshield{Enter}');
    await waitFor(() => expect(posts).toEqual([{ text: 'Pause binshield' }]));
    expect(composer()).toHaveValue('');
    first.unmount();
    await mount();
    expect(composer()).toHaveValue('');
  });

  it('keeps the draft when the token dialog is cancelled', async () => {
    const posts = stubFetch();
    const first = await mount();
    await userEvent.type(composer(), 'Wait for the token{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
    first.unmount();
    await mount();
    expect(composer()).toHaveValue('Wait for the token');
  });

  it('keeps an answer draft across remount and clears it after the answer is sent', async () => {
    setMutationToken(TOKEN);
    const posts = stubFetch();
    const first = await mount();
    await userEvent.type(await answerBox(), 'Keep local enforcement');
    first.unmount();
    const second = await mount();
    expect(await answerBox()).toHaveValue('Keep local enforcement');
    await userEvent.type(await answerBox(), '{Enter}');
    await waitFor(() => expect(posts.length).toBe(1));
    second.unmount();
    await mount();
    expect(composer()).toHaveValue('');
    // The answered question no longer offers a box; the stored copy is gone either way.
    expect(localStorage.getItem('ashlr.verse.drafts.v1') ?? '').not.toContain('Keep local enforcement');
  });

  it('is removed by the logout wipe', async () => {
    stubFetch();
    const first = await mount();
    await userEvent.type(composer(), 'Private words');
    first.unmount();
    clearComposerMemory();
    await mount();
    expect(composer()).toHaveValue('');
  });
});
