import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PendingApprovalsView } from './PendingApprovalsView.js';
import { evictAll } from '../../data/cache.js';
import { clearMutationToken } from '../../data/auth-store.js';
import type { PendingApprovalItem, PendingApprovalsResponse } from '../../data/api-types.js';

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

function consentItem(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'proposal:p_1',
    source: 'proposal',
    kind: 'patch',
    title: 'Add retry to fetch wrapper',
    detail: 'Wraps fetch with bounded retries',
    parameters: { repo: '/repos/ashlr-hub', origin: 'swarm', partial: false, engine: 'codex:gpt-5.5' },
    createdAt: OLD,
    status: 'pending',
    reviewPath: '/inbox/p_1',
    decide: { mode: 'consent', proposalId: 'p_1', revision: 'approval-v1:0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef', partial: false },
    ...overrides,
  };
}

function draftItem(): PendingApprovalItem {
  return {
    id: 'draft:d-0123456789abcdef',
    source: 'draft',
    kind: 'email-draft',
    title: 'Quarterly numbers',
    detail: 'to reviewer@example.test',
    parameters: { channel: 'email', to: 'reviewer@example.test', source: 'outbox-1.json', digest: 'abcdef123456' },
    createdAt: NOW,
    status: 'pending',
    decide: {
      mode: 'terminal',
      approveCommand: 'phm drafts approve d-0123456789abcdef',
      denyCommand: 'phm drafts reject d-0123456789abcdef',
      showCommand: 'phm drafts show d-0123456789abcdef',
    },
  };
}

function teamItem(): PendingApprovalItem {
  return {
    id: 'team-approval:default:ev-1',
    source: 'team-approval',
    kind: 'team:release',
    title: 'Ship the release candidate',
    detail: 'requested by agent:codex/acct-1',
    parameters: { team: 'default', action: 'release', requestedBy: 'agent:codex/acct-1', handoff: 'h-1' },
    createdAt: NOW,
    status: 'pending',
    decide: {
      mode: 'terminal',
      approveCommand: 'phm team approve ev-1 --team default',
      denyCommand: 'phm team deny ev-1 --team default',
      showCommand: 'phm team view --team default',
    },
  };
}

function response(overrides: Partial<PendingApprovalsResponse> = {}): PendingApprovalsResponse {
  return {
    generatedAt: NOW,
    dispatchEnabled: true,
    sources: {
      proposal: { sourceState: 'healthy', complete: true },
      draft: { sourceState: 'healthy', complete: true },
      'team-approval': { sourceState: 'healthy', complete: true },
    },
    approvals: [consentItem(), draftItem(), teamItem()],
    truncated: false,
    ...overrides,
  };
}

function mockFetch(body: PendingApprovalsResponse, onPost?: (url: string, init?: RequestInit) => void) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if ((init?.method ?? 'GET') === 'POST' && url.includes('/decision')) {
      onPost?.(url, init);
      return new Response(JSON.stringify({ ok: true, id: 'p_1', status: 'approved' }), { status: 200 });
    }
    if (url.startsWith('/api/approvals')) return new Response(JSON.stringify(body), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

function renderView() {
  return render(
    <MemoryRouter>
      <PendingApprovalsView />
    </MemoryRouter>,
  );
}

describe('PendingApprovalsView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearMutationToken();
  });

  it('lists every pending request with id-derived title, kind, parameters, age and status', async () => {
    vi.stubGlobal('fetch', mockFetch(response()));
    renderView();

    await waitFor(() => expect(screen.getByText('Add retry to fetch wrapper')).toBeInTheDocument());
    expect(screen.getByText('Ship the release candidate')).toBeInTheDocument();
    expect(screen.getByText('Quarterly numbers')).toBeInTheDocument();
    // Kind + source columns
    expect(screen.getAllByText('Patch').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Email draft').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Team: release').length).toBeGreaterThan(0);
    // Parameters render as metadata chips, never raw JSON
    expect(screen.getByText('reviewer@example.test')).toBeInTheDocument();
    expect(screen.getByText('agent:codex/acct-1')).toBeInTheDocument();
    // Age column renders a compact age for the 3h-old proposal
    expect(screen.getAllByText('3h').length).toBeGreaterThan(0);
    // Status column
    expect(screen.getAllByText('pending').length).toBeGreaterThanOrEqual(3);
  });

  it('shows approve/deny only for consent rows and terminal commands for the rest', async () => {
    vi.stubGlobal('fetch', mockFetch(response()));
    renderView();
    await waitFor(() => expect(screen.getByText('Add retry to fetch wrapper')).toBeInTheDocument());

    const proposalRow = screen.getByText('Add retry to fetch wrapper').closest('tr')!;
    expect(within(proposalRow).getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(within(proposalRow).getByRole('button', { name: /deny/i })).toBeInTheDocument();
    expect(within(proposalRow).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/inbox/p_1');

    const draftRow = screen.getByText('Quarterly numbers').closest('tr')!;
    expect(within(draftRow).queryByRole('button')).not.toBeInTheDocument();
    expect(within(draftRow).getByText('phm drafts approve d-0123456789abcdef')).toBeInTheDocument();
    expect(within(draftRow).getByText('phm drafts reject d-0123456789abcdef')).toBeInTheDocument();

    const teamRow = screen.getByText('Ship the release candidate').closest('tr')!;
    expect(within(teamRow).queryByRole('button')).not.toBeInTheDocument();
    expect(within(teamRow).getByText('phm team approve ev-1 --team default')).toBeInTheDocument();
  });

  it('records a consent decision through the token + confirm flow, posting revision and decision only', async () => {
    const user = userEvent.setup();
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        if (method === 'POST' && url.includes('/decision')) {
          posts.push({ url, body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ok: true, id: 'p_1', status: 'approved' }), { status: 200 });
        }
        if (url.startsWith('/api/approvals')) return new Response(JSON.stringify(response()), { status: 200 });
        return new Response('not found', { status: 404 });
      }),
    );
    renderView();
    await waitFor(() => expect(screen.getByText('Add retry to fetch wrapper')).toBeInTheDocument());

    const row = screen.getByText('Add retry to fetch wrapper').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /approve/i }));

    // Confirm dialog explains consent-only semantics before any token ask.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/does not execute the action/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Record approval' }));

    // No mutation hold yet → token dialog, never a silent POST.
    const tokenInput = await screen.findByLabelText('Mutation token');
    expect(posts).toHaveLength(0);
    await user.type(tokenInput, 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/inbox/p_1/decision');
    expect(posts[0]!.body).toEqual({
      revision: 'approval-v1:0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef',
      decision: 'approve',
    });
  });

  it('denies through the same consent path', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if ((init?.method ?? 'GET') === 'POST' && url.includes('/decision')) {
          posts.push(JSON.parse(String(init?.body)));
          return new Response('{}', { status: 200 });
        }
        if (url.startsWith('/api/approvals')) return new Response(JSON.stringify(response()), { status: 200 });
        return new Response('not found', { status: 404 });
      }),
    );
    renderView();
    await waitFor(() => expect(screen.getByText('Add retry to fetch wrapper')).toBeInTheDocument());

    const row = screen.getByText('Add retry to fetch wrapper').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /deny/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Record denial' }));
    const tokenInput = await screen.findByLabelText('Mutation token');
    await user.type(tokenInput, 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ decision: 'deny' });
  });

  it('disables approve for partial captures but keeps deny', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        response({
          approvals: [consentItem({ decide: { mode: 'consent', proposalId: 'p_1', revision: 'approval-v1:0123456789abcdef.0123456789abcdef.0123456789abcdef.0123456789abcdef', partial: true } })],
        }),
      ),
    );
    renderView();
    await waitFor(() => expect(screen.getByText('Add retry to fetch wrapper')).toBeInTheDocument());
    const row = screen.getByText('Add retry to fetch wrapper').closest('tr')!;
    expect(within(row).getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(within(row).getByRole('button', { name: /deny/i })).toBeEnabled();
    expect(within(row).getByText(/partial capture/i)).toBeInTheDocument();
  });

  it('withholds consent buttons and says so when dispatch is disabled', async () => {
    vi.stubGlobal('fetch', mockFetch(response({ dispatchEnabled: false })));
    renderView();
    await waitFor(() => expect(screen.getByText('Add retry to fetch wrapper')).toBeInTheDocument());
    const row = screen.getByText('Add retry to fetch wrapper').closest('tr')!;
    expect(within(row).queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(within(row).getByText(/read-only/i)).toBeInTheDocument();
    // Terminal + review affordances are unaffected.
    expect(screen.getByText('phm drafts approve d-0123456789abcdef')).toBeInTheDocument();
  });

  it('announces degraded sources instead of claiming an all-clear', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        response({
          sources: {
            proposal: { sourceState: 'healthy', complete: true },
            draft: { sourceState: 'degraded', complete: false, reason: 'draft store read failed' },
            'team-approval': { sourceState: 'missing', complete: true },
          },
          approvals: [],
        }),
      ),
    );
    renderView();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/may be incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing is waiting on you/i)).not.toBeInTheDocument();
  });

  it('claims the all-clear only when every source is readable and empty', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        response({
          sources: {
            proposal: { sourceState: 'missing', complete: true },
            draft: { sourceState: 'missing', complete: true },
            'team-approval': { sourceState: 'missing', complete: true },
          },
          approvals: [],
        }),
      ),
    );
    renderView();
    await waitFor(() => expect(screen.getByText(/nothing is waiting on you/i)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders parameter values as inert text — markup in metadata cannot inject nodes', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(
        response({
          approvals: [
            consentItem({
              title: 'Normal title',
              parameters: { repo: '<img src=x onerror=alert(1)>', origin: 'swarm' },
            }),
          ],
        }),
      ),
    );
    const { container } = renderView();
    await waitFor(() => expect(screen.getByText('Normal title')).toBeInTheDocument());
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });
});
