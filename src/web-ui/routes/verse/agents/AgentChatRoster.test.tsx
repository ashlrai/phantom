import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setFeatureFlag } from '../../../app/desktop-state.js';
import { resetFeatureFlagsForTests } from '../../../data/feature-flags.js';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { bootstrap, CLAUDE_SEAT, ev, session } from '../fixtures.test-support.js';
import { Sidebar } from '../Sidebar.js';
import { Workspace } from '../Workspace.js';
import { useVerseSession } from '../useVerseSession.js';
import { resetVerseStore, seedVerseSession } from '../verse-store.js';
import { resetDockStore } from '../dock/dock-store.js';
import { agentWorkspaceEnabled } from './agent-workspace-flag.js';

const SID = 'vs_roster';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
let reads: string[];
let uploads: Array<Record<string, unknown>>;
let boardFails: boolean;
const sent = vi.fn(async () => true);

function Harness() {
  const [selected, select] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const view = useVerseSession(selected);
  return <>
    <Sidebar sessions={[]} sessionsStatus="success" sessionsError={null} projects={[]} seats={[CLAUDE_SEAT]}
      selectedId={selected} query={query} onQuery={setQuery} onSelect={select} onNew={() => {}}
      onRetry={() => {}} onCollapse={() => {}} onDisconnect={() => {}} />
    <Workspace view={view} seats={[CLAUDE_SEAT]} projects={bootstrap().projects} dispatchEnabled locked={false}
      hasAnySessions onSend={sent} onStop={() => {}} onRename={async () => true} onRequestDelete={() => {}}
      onSeatChange={() => {}} onNew={() => {}} onRetry={() => {}} sidebarCollapsed={false}
      onToggleSidebar={() => {}} handoffOpen={false} onHandoffOpenChange={() => {}} otherRunning={[]} />
  </>;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/?agentWorkspace=1');
  localStorage.clear();
  resetFeatureFlagsForTests();
  evictAll();
  resetVerseStore();
  resetDockStore();
  setMutationToken('test-only-mutation');
  sent.mockClear();
  reads = [];
  uploads = [];
  boardFails = false;
  seedVerseSession(SID, session({ id: SID, status: 'idle', turnCount: 1 }), [
    ev(1, 'user-message', { turnId: 't1', text: 'Review the change' }),
    ev(2, 'assistant-message', { turnId: 't1', text: '**Reviewed**\n\n```ts\nconst ready = true;\n```' }),
    ev(3, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 10 }),
  ]);
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    reads.push(url);
    if (url === '/api/verse/agents') {
      if (boardFails) return json({ error: 'test-private-error' }, 500);
      return json({ cards: [
        { id: 'ag_roster', agentId: 'ag_roster', sessionId: SID, title: 'Review agent', archived: false,
          env: { KEY: 'test-private-secret' }, token: 'test-private-token', capability: 'test-private-capability',
          plan: { text: 'test-private-plan' }, scripts: ['test-private-script'] },
        { id: 'ag_unbound', agentId: 'ag_unbound', sessionId: null, title: 'Unbound agent' },
        { id: 'ag_archived', agentId: 'ag_archived', sessionId: 'vs_old', title: 'Archived agent', archived: true },
        { id: 'chat:ordinary', agentId: null, sessionId: 'vs_other', title: 'Ordinary chat' },
      ] });
    }
    if (url === `/api/verse/attachments/${SID}` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      uploads.push(body);
      return json({ id: `attachment${uploads.length}`, sessionId: SID, name: body.name, mime: body.mime,
        bytes: 5, ref: `@~/.ashlr/verse/attachments/${SID}/${String(body.name)}`, createdAt: new Date().toISOString() }, 201);
    }
    return json({}, 404);
  }));
});
afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/verse/');
});

describe('agentWorkspace preview', () => {
  it('shows and hides the roster when the workspace preference changes', async () => {
    window.history.replaceState(null, '', '/verse/');
    render(<Harness />);
    expect(screen.queryByRole('region', { name: 'Agent chats' })).not.toBeInTheDocument();
    act(() => setFeatureFlag('agentWorkspace', true));
    await screen.findByRole('button', { name: 'Review agent' });
    act(() => setFeatureFlag('agentWorkspace', false));
    expect(screen.queryByRole('region', { name: 'Agent chats' })).not.toBeInTheDocument();
  });
  it.each(['', '?agentWorkspace=0', '?agentWorkspace=true'])('stays off without exact opt-in (%s), without fetching a roster', async search => {
    window.history.replaceState(null, '', `/verse/${search}`);
    expect(agentWorkspaceEnabled()).toBe(false);
    render(<Harness />);
    expect(within(screen.getByRole('navigation', { name: 'Chats' })).getByRole('button', { name: 'New chat' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Agent chats' })).not.toBeInTheDocument();
    expect(screen.queryByText('Review agent')).not.toBeInTheDocument();
    expect(reads).not.toContain('/api/verse/agents');
  });

  it('opens the bound chat by keyboard, renders markdown, and sends file and image references through the existing composer', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const row = await screen.findByRole('button', { name: 'Review agent' });
    expect(screen.queryByText('Unbound agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Archived agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Ordinary chat')).not.toBeInTheDocument();
    screen.getByRole('searchbox', { name: 'Search chats and messages' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(row).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Reviewed').tagName).toBe('STRONG');
    expect(screen.getByText('const ready = true;').tagName).toBe('CODE');
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'Please inspect');
    for (const [name, type] of [['notes.md', 'text/markdown'], ['screen.png', 'image/png']]) {
      fireEvent.paste(box, { clipboardData: { files: [new File(['hello'], name, { type })], getData: () => '' } });
      await waitFor(() => expect(within(screen.getByRole('list', { name: 'Attachments' })).getByRole('button', { name: `Remove ${name}` })).toBeEnabled());
      await waitFor(() => expect((box as HTMLTextAreaElement).value).toContain(name));
    }
    expect(uploads.map(upload => upload.mime)).toEqual(['text/markdown', 'image/png']);
    await user.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith(expect.stringContaining(`@~/.ashlr/verse/attachments/${SID}/notes.md`)));
    expect(sent).toHaveBeenCalledWith(expect.stringContaining(`@~/.ashlr/verse/attachments/${SID}/screen.png`));
  });

  it('projects only public roster fields and redacts raw failures', async () => {
    const mounted = render(<Harness />);
    await screen.findByRole('button', { name: 'Review agent' });
    expect(mounted.container.innerHTML).not.toMatch(/test-private-/);
    mounted.unmount();
    evictAll();
    boardFails = true;
    const failed = render(<Harness />);
    await screen.findByText('Agent chats unavailable.');
    expect(failed.container.innerHTML).not.toMatch(/test-private-/);
    boardFails = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Review agent' });
  });
});
