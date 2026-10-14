import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceSetupSheet } from './WorkspaceSetupSheet.js';
const f = vi.hoisted(() => ({ insert: vi.fn(), copy: vi.fn(), context: vi.fn() }));
vi.mock('../../useVerseUi.js', () => ({ useVerseUi: () => ({ activeSessionId: 'chat-1', section: 'chat' }) }));
vi.mock('../../verse-store.js', () => ({ subscribeVerseSession: () => () => {}, getVerseSessionHead: () => HEAD }));
vi.mock('../../chat/composer-bridge.js', () => ({ insertIntoComposer: f.insert }));
vi.mock('./ImportContextPane.js', () => ({ ImportContextPane: () => { f.context(); return <textarea aria-label="Context draft" defaultValue="" />; } }));
const HEAD = { session: { id: 'chat-1', projectPath: '/fixture/project' } };
beforeEach(() => { vi.clearAllMocks(); f.insert.mockReturnValue(true); f.copy.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());
describe('workspace setup sheet', () => {
  it('shows four distinct tools without reading context or claiming companion readiness', () => {
    render(<WorkspaceSetupSheet onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Set up my workspace' })).toBeInTheDocument();
    for (const name of ['Phantom', 'Phantom Secrets', 'Locus', 'Lexicon']) expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    expect(screen.getAllByText('Installation and runtime readiness not checked')).toHaveLength(3);
    expect(f.context).not.toHaveBeenCalled();
  });
  it('adds a setup brief to the selected message draft without sending a turn', async () => {
    render(<WorkspaceSetupSheet onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add brief to message' }));
    expect(f.insert).toHaveBeenCalledExactlyOnceWith('chat-1', expect.stringContaining('Help me set up Phantom'));
    expect(screen.getByText(/Review it before sending/)).toBeInTheDocument();
  });
  it('preserves a context draft when switching between setup tabs', async () => {
    render(<WorkspaceSetupSheet onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Bring your context' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Context draft' }), 'Local notes');
    await userEvent.click(screen.getByRole('button', { name: 'Developer tools' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bring your context' }));
    expect(screen.getByRole('textbox', { name: 'Context draft' })).toHaveValue('Local notes');
  });
  it('supports Escape dismissal through the shared sheet focus contract', async () => {
    const close = vi.fn(); render(<WorkspaceSetupSheet onClose={close} />);
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    await userEvent.keyboard('{Escape}'); expect(close).toHaveBeenCalledOnce();
  });
});
