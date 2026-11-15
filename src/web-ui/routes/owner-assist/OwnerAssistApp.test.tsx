import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OwnerAssistPanel } from './OwnerAssistApp.js';
import { ownerAssistApi } from './client.js';
import { agentToolsApi } from '../verse/agent-tools/agent-tools-client.js';
import type { OwnerAssistSnapshot, OwnerAssistDetail } from '../../../core/owner-assist/types.js';

const id = '11111111-1111-4111-8111-111111111111';
function fixture(running = false) {
  const session = { id, title: 'Weyv', projectPath: '/projects/weyv', model: 'qwen-32b', engine: 'local', status: running ? 'running' : 'idle' } as OwnerAssistDetail['session'];
  const detail: OwnerAssistDetail = { session, events: [{ seq: 1, type: 'assistant-message', turnId: 't', at: 'now', text: 'I can work on this project.' }], pending: [] };
  const snapshot: OwnerAssistSnapshot = { scope: 'owner', concurrency: 1, preferences: { callsign: 'Scout', preference: 'local' }, memory: 'Prefer small diffs', sessions: [session], seats: [] };
  const api = {
    snapshot: vi.fn(async () => snapshot), detail: vi.fn(async () => detail), send: vi.fn(async () => ({ session, turnId: 't' })),
    cancel: vi.fn(async () => ({})), configure: vi.fn(async () => ({})), remember: vi.fn(async () => ({})),
    handoff: vi.fn(async (job) => ({ ...job, fleetJobId: 'RQ-PHX-OWNER1', status: 'SUBMITTED' })), handoffs: vi.fn(async () => []),
  } as typeof ownerAssistApi;
  return { api, detail, snapshot };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.__ASHLR_OWNER_WINDOW__; });
describe('Owner Assist surface', () => {
  it('restores owner identity and project, sends model preference without fleet mutation', async () => {
    const { api } = fixture(); render(<OwnerAssistPanel api={api} />);
    await screen.findByText('Scout'); await screen.findByText('I can work on this project.');
    expect(screen.getByLabelText('Project folder')).toHaveValue('/projects/weyv');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Build the widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, preference: 'local', text: 'Build the widget', projectPath: '/projects/weyv' })));
    expect(api.handoff).not.toHaveBeenCalled();
  });
  it('offers only one-shot allow and deny for the exact pending command', async () => {
    const { api, detail } = fixture(true);
    detail.pending = [{ id: 'c1', sessionId: id, at: 'now', expiresAt: 'later', tool: 'terminal_run', rule: 'shell', reason: 'Review command', command: 'npm test', tabId: null }];
    const confirm = vi.spyOn(agentToolsApi, 'confirm').mockResolvedValue();
    render(<OwnerAssistPanel api={api} />);
    await screen.findByText('npm test');
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(id, 'c1', 'once'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(id, 'c1', 'deny'));
    expect(screen.queryByText('Allow for chat')).not.toBeInTheDocument();
  });
  it('keeps collapsed and fullscreen states usable in the browser fallback', async () => {
    render(<OwnerAssistPanel api={fixture().api} />); await screen.findByText('Scout');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    await screen.findByRole('button', { name: 'Open' });
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fullscreen' }));
    expect(await screen.findByRole('button', { name: 'Restore window' })).toBeInTheDocument();
  });
  it('keeps a failed message available to retry and surfaces the failure', async () => {
    const { api } = fixture(); vi.mocked(api.send).mockRejectedValue(new Error('No local model available'));
    render(<OwnerAssistPanel api={api} />); await screen.findByText('I can work on this project.');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No local model available');
    expect(screen.getByLabelText('Message')).toHaveValue('Keep my draft');
  });
  it('requires explicit fleet action with repository and acceptance criteria', async () => {
    const { api } = fixture(); render(<OwnerAssistPanel api={api} />); await screen.findByText('Scout');
    fireEvent.click(screen.getByRole('button', { name: 'Hand off to fleet' }));
    expect(screen.getByRole('button', { name: 'Enqueue fleet task' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'ashlrai/phantom' } });
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Widget tests pass' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Fix widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enqueue fleet task' }));
    await waitFor(() => expect(api.handoff).toHaveBeenCalledWith(expect.objectContaining({ repo: 'ashlrai/phantom', scope: 'Fix widget', acceptance: 'Widget tests pass', tier: 'work' })));
    expect(api.send).not.toHaveBeenCalled();
    await screen.findByText(/Fleet: Fix widget · SUBMITTED/);
  });
});
