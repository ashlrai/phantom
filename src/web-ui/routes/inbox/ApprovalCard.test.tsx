import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, Proposal } from '../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { ApprovalDetail } from '../verse/approvals/ApprovalDetail.js';
import { ApprovalCard } from './ApprovalCard.js';
import { ProposalDetail } from './ProposalDetail.js';

const FAKE_TOKEN = 'f'.repeat(64); // Runtime-only FAKE authentication fixture.
const revision = `approval-v1:${Array(4).fill('a'.repeat(16)).join('.')}`;
const proposal: Proposal = {
  id: 'card-1', kind: 'patch', origin: 'manual', repo: '/repos/example',
  title: 'Fix retry handling', summary: 'Retry only transient failures.',
  status: 'pending', createdAt: '2026-10-26T10:00:00.000Z',
  diff: '--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-old\n+new\n',
};
const request: ApprovalRequest = {
  schemaVersion: 1, proposalId: proposal.id, revision,
  action: { kind: 'patch', description: 'Apply patch' },
  scope: { repo: proposal.repo, sandboxId: 'sandbox-1' },
  diffPreview: { text: proposal.diff!, truncated: false },
};
let posts: Array<{ path: string; body: unknown; authenticated: boolean }>;
let responseStatus: number;
let responseBody: unknown;

beforeEach(() => {
  evictAll();
  clearMutationToken();
  window.history.replaceState({}, '', '/');
  posts = [];
  responseStatus = 200;
  responseBody = { ok: true };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)),
        authenticated: (init.headers as Record<string, string>)['x-ashlr-token'] === FAKE_TOKEN });
      return new Response(JSON.stringify(responseBody), { status: responseStatus });
    }
    return new Response(JSON.stringify({ ...proposal, approvalRequest: request,
      decisionEvidence: { sourceQuality: { sourceState: 'healthy', complete: true }, decisions: [] } }), { status: 200 });
  }));
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function card(overrides: Partial<Parameters<typeof ApprovalCard>[0]> = {}) {
  return render(<ApprovalCard proposal={proposal} request={request} onDispatchDisabled={() => {}} {...overrides} />);
}

describe('approval request card', () => {
  it('shows the action, exact scope, and expandable diff preview', async () => {
    const user = userEvent.setup();
    card({ request: { ...request, diffPreview: { ...request.diffPreview, truncated: true } } });
    expect(screen.getByText('Apply patch')).toBeInTheDocument();
    expect(screen.getByText('/repos/example')).toBeInTheDocument();
    expect(screen.getByText(/sandbox-1/)).toBeInTheDocument();
    await user.click(screen.getByText('Diff preview'));
    expect(screen.getByText(/Preview shortened/)).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  it.each(['approve', 'deny'] as const)('confirms, authenticates, then records %s for the reviewed revision', async (decision) => {
    const user = userEvent.setup();
    card();
    await user.click(screen.getByRole('button', { name: decision === 'approve' ? 'Approve…' : 'Deny…' }));
    const dialog = screen.getByRole('dialog', { name: decision === 'approve' ? 'Approve this request?' : 'Deny this request?' });
    expect(screen.queryByRole('dialog', { name: 'Unlock actions' })).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: decision === 'approve' ? 'Record approval' : 'Record denial' }));
    const unlock = screen.getByRole('dialog', { name: 'Unlock actions' });
    expect(posts).toHaveLength(0);
    await user.type(within(unlock).getByLabelText('Mutation token'), FAKE_TOKEN);
    await user.click(within(unlock).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(posts).toEqual([{ path: '/api/inbox/card-1/decision', body: { revision, decision }, authenticated: true }]));
    expect(await screen.findByRole('status')).toHaveTextContent(decision === 'approve' ? 'approved' : 'denied');
    expect(screen.queryByRole('button', { name: 'Approve…' })).not.toBeInTheDocument();
  });

  it('cancels before authentication without writing anything', async () => {
    const user = userEvent.setup();
    card();
    await user.click(screen.getByRole('button', { name: 'Approve…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('uses a held token only after explicit confirmation', async () => {
    const user = userEvent.setup();
    setMutationToken(FAKE_TOKEN);
    card();
    await user.click(screen.getByRole('button', { name: 'Approve…' }));
    expect(posts).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Record approval' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.path).toBe('/api/inbox/card-1/decision');
  });

  it('shows stale-request errors without reporting success', async () => {
    const user = userEvent.setup();
    setMutationToken(FAKE_TOKEN);
    responseStatus = 409;
    responseBody = { error: 'This approval request changed. Reload before deciding.', code: 'conflict' };
    card();
    await user.click(screen.getByRole('button', { name: 'Approve…' }));
    await user.click(screen.getByRole('button', { name: 'Record approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/request changed/);
    expect(screen.queryByText(/Decision recorded/)).not.toBeInTheDocument();
  });

  it('reports a disabled server and prevents another decision attempt', async () => {
    const user = userEvent.setup();
    const onDispatchDisabled = vi.fn();
    setMutationToken(FAKE_TOKEN);
    responseStatus = 404;
    responseBody = { error: 'not found' };
    card({ onDispatchDisabled });
    await user.click(screen.getByRole('button', { name: 'Approve…' }));
    await user.click(screen.getByRole('button', { name: 'Record approval' }));
    await waitFor(() => expect(onDispatchDisabled).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/dispatch is disabled/);
  });

  it('withholds decisions for absent requests and mismatched proposal identities', () => {
    const view = card({ request: null });
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeDisabled();
    view.rerender(<ApprovalCard proposal={proposal} request={{ ...request, proposalId: 'another' }} onDispatchDisabled={() => {}} />);
    expect(screen.getByRole('button', { name: 'Deny…' })).toBeDisabled();
  });

  it('allows denial but withholds approval for partial captures', () => {
    card({ proposal: { ...proposal, isPartial: true } });
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny…' })).toBeEnabled();
  });

  it('withholds both decisions when dispatch is disabled', () => {
    card({ dispatchEnabled: false });
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny…' })).toBeDisabled();
  });

  it('renders persisted decisions without actionable buttons', () => {
    card({ proposal: { ...proposal, status: 'rejected', approvalDecision: { revision, decision: 'deny', decidedAt: proposal.createdAt } } });
    expect(screen.getByRole('status')).toHaveTextContent('Decision recorded: denied.');
    expect(screen.queryByRole('button', { name: 'Deny…' })).not.toBeInTheDocument();
  });
});

describe('agentWorkspace opt-in', () => {
  it.each(['', '?agentWorkspace=0', '?agentWorkspace=true'])('stays off for %s', async (search) => {
    window.history.replaceState({}, '', `/${search}`);
    render(<MemoryRouter><ProposalDetail id={proposal.id} onDispatchDisabled={() => {}} /></MemoryRouter>);
    await screen.findByText('Fix retry handling');
    expect(screen.queryByRole('region', { name: 'Approval request' })).not.toBeInTheDocument();
  });

  it.each(['legacy', 'verse'])('mounts the card in the %s inbox only with the flag enabled', async (surface) => {
    const detail = surface === 'legacy'
      ? <MemoryRouter><ProposalDetail id={proposal.id} onDispatchDisabled={() => {}} /></MemoryRouter>
      : <ApprovalDetail id={proposal.id} dispatchEnabled onDispatchDisabled={() => {}} onDecided={() => {}} />;
    const view = render(detail);
    await screen.findByText('Fix retry handling');
    expect(screen.queryByRole('region', { name: 'Approval request' })).not.toBeInTheDocument();
    window.history.replaceState({}, '', '/?agentWorkspace=1');
    view.rerender(detail.type === MemoryRouter
      ? <MemoryRouter><ProposalDetail id={proposal.id} onDispatchDisabled={() => {}} /></MemoryRouter>
      : <ApprovalDetail id={proposal.id} dispatchEnabled onDispatchDisabled={() => {}} onDecided={() => {}} />);
    expect(await screen.findByRole('region', { name: 'Approval request' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });
});
