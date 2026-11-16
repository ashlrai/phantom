import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApprovalsView, formatAge } from './ApprovalsView.js';
import { evictAll } from '../../data/cache.js';
import { setMutationToken } from '../../data/auth-store.js';

type Json = Record<string, unknown>;
const projection = (over: Json = {}): Json => ({
  generatedAt: '2026-11-10T00:00:00Z',
  team: 'default',
  teamApprovals: { state: 'ok', items: [] },
  proposals: { state: 'ok', items: [], truncated: false },
  drafts: { state: 'ok', items: [], truncated: false },
  pins: { state: 'ok', root: '/x/staged', items: [] },
  holds: { state: 'ok', path: '/x/holds.json', configured: true, items: [] },
  ...over,
});

function stubFetch(body: Json, onPost?: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && onPost) return onPost(url, init);
    if (url.startsWith('/api/approvals')) return new Response(JSON.stringify(body), { status: 200 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const renderView = () => render(<MemoryRouter><ApprovalsView /></MemoryRouter>);

describe('ApprovalsView', () => {
  beforeEach(() => { evictAll(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders honest empty states for all three sections', async () => {
    stubFetch(projection());
    renderView();
    await waitFor(() => expect(screen.getByText('Nothing pending.')).toBeInTheDocument());
    expect(screen.getByText('Nothing staged.')).toBeInTheDocument();
    expect(screen.getByText('No open holds.')).toBeInTheDocument();
  });

  it('shows an unavailable source distinctly from empty', async () => {
    stubFetch(projection({ holds: { state: 'unavailable', reason: 'bad json', path: '/x', configured: true, items: [] } }));
    renderView();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/bad json.*not the same as "nothing pending"/));
    expect(screen.queryByText('No open holds.')).not.toBeInTheDocument();
  });

  it('lists pins read-only and holds', async () => {
    stubFetch(projection({
      pins: { state: 'ok', root: '/x', items: [{ name: 'pkg-a', filesTouched: 3, truncated: false, stagedAt: 'z', ageMs: 5 * 3_600_000 }] },
      holds: { state: 'ok', path: '/x', configured: true, items: [{ id: 'h1', title: 'weyv-cloud first push', detail: null, since: null }] },
    }));
    renderView();
    await waitFor(() => expect(screen.getByText('pkg-a')).toBeInTheDocument());
    expect(screen.getByText(/3 files · staged 5h ago/)).toBeInTheDocument();
    expect(screen.getByText('weyv-cloud first push')).toBeInTheDocument();
    // Pins stay Security's: the only decision buttons are for team approvals.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('posts the human decision and surfaces a refusal', async () => {
    setMutationToken('tok');
    const fn = stubFetch(
      projection({ teamApprovals: { state: 'ok', items: [{ id: 'ap1', kind: 'access', summary: 'Access request: invite human:evan', requestedBy: 'agent:codex', note: null, command: 'phm team approve ap1 --team default' }] } }),
      () => new Response(JSON.stringify({ error: 'Approval not applied' }), { status: 403 }),
    );
    renderView();
    await waitFor(() => expect(screen.getByText('Access request: invite human:evan')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const post = fn.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(post[0])).toBe('/api/approvals/team/ap1/decision');
    expect(JSON.parse(String(post[1]!.body))).toEqual({ decision: 'approve', team: 'default' });
  });

  it('formats ages', () => {
    expect(formatAge(5 * 60_000)).toBe('5m');
    expect(formatAge(5 * 3_600_000)).toBe('5h');
    expect(formatAge(72 * 3_600_000)).toBe('3d');
  });
});
